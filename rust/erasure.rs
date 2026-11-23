//! General's shared save retains the seat, under a fresh per-match UUID with no account.
use crate::model::{Room, id};
use anyhow::{Context, Result, ensure};
use bytes::Bytes;
use flate2::{Compression, read::DeflateDecoder, write::DeflateEncoder};
use serde_json::{Value, json};
use std::io::{Read, Write};

const MAX_TEXT: usize = 12000 * 1024;

fn unpack(bytes: &[u8]) -> Result<Value> {
    ensure!(
        bytes.len() >= 5 && bytes.len() <= MAX_TEXT + 5,
        "invalid frame"
    );
    let length = u32::from_be_bytes(bytes[1..5].try_into()?) as usize;
    ensure!(length <= MAX_TEXT, "invalid size");
    let raw = match bytes[0] {
        0 => bytes[5..].to_vec(),
        1 => {
            let mut raw = Vec::new();
            DeflateDecoder::new(&bytes[5..])
                .take(length as u64 + 1)
                .read_to_end(&mut raw)?;
            raw
        }
        _ => anyhow::bail!("unknown encoding"),
    };
    ensure!(raw.len() == length, "invalid length");
    Ok(serde_json::from_slice(&raw)?)
}

fn pack(value: &Value) -> Result<Bytes> {
    let raw = serde_json::to_vec(value)?;
    ensure!(raw.len() <= MAX_TEXT, "save too large");
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(&raw)?;
    let compressed = encoder.finish()?;
    let mut frame = vec![u8::from(compressed.len() < raw.len())];
    frame.extend_from_slice(&(raw.len() as u32).to_be_bytes());
    frame.extend_from_slice(if frame[0] == 1 { &compressed } else { &raw });
    Ok(frame.into())
}

pub fn current_save(bytes: &[u8], key: &Value) -> bool {
    unpack(bytes).is_ok_and(|save| &save["key"] == key)
}

pub fn anonymize(room: &mut Room, player: &str, account_name: &str) -> Result<()> {
    ensure!(
        room.game["app"] == "general-connect" && room.persistent,
        "unknown shared game"
    );
    let alias = id();
    let roster = room.start["players"].as_array().context("missing roster")?;
    let seat = roster
        .iter()
        .position(|v| v == player)
        .context("missing seat")?;
    let name = room.start["names"][player].as_str();
    if room.owner == player || name == Some(room.name.as_str()) || room.name == account_name {
        room.name = "General".into();
    }
    let key = room.start["key"]
        .as_str()
        .and_then(|k| k.rsplit_once('|'))
        .context("missing match key")?;
    let key = format!("{}|{}", key.0, id());
    if !room.state.is_empty() {
        let mut save = unpack(&room.state)?;
        ensure!(
            save["version"] == 1
                && save["world"]["version"] == 1
                && save["key"] == room.start["key"],
            "unknown save"
        );
        let world = &mut save["world"]["game"];
        let nation = world["humanOrder"][seat]
            .as_u64()
            .and_then(|n| n.checked_sub(1))
            .context("missing nation")? as usize;
        let nation = world["nations"]
            .get_mut(nation)
            .and_then(Value::as_object_mut)
            .context("missing nation")?;
        nation.insert("ruler".into(), json!("Player"));
        nation.remove("emoji");
        save["orders"]
            .as_array_mut()
            .context("missing orders")?
            .retain(|entry| entry[0] != player);
        save["key"] = json!(key);
        room.state = pack(&save)?;
    }
    for field in [
        "names",
        "avatarImages",
        "avatarSeeds",
        "playerRatings",
        "countries",
    ] {
        if let Some(map) = room.start[field].as_object_mut()
            && let Some(old) = map.remove(player)
        {
            match field {
                "countries" => {
                    map.insert(alias.clone(), old);
                }
                "names" => {
                    map.insert(alias.clone(), json!("Player"));
                }
                _ => {}
            }
        }
    }
    room.start["players"][seat] = json!(alias);
    room.start["key"] = json!(key);
    room.start["anonymizedRoster"] = json!(true);
    let index = room
        .players
        .get_index_of(player)
        .context("missing room participant")?;
    room.players.shift_remove(player);
    room.players.shift_insert(index, alias.clone());
    if room.owner == player {
        room.owner = alias;
    }
    room.reservations.shift_remove(player);
    room.generation += 1;
    room.revision += 1;
    room.upload = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_save_keeps_seats_world_and_other_player_after_reload() {
        let dir = std::env::temp_dir().join(id());
        let store = crate::store::Store::new(dir.to_str().unwrap(), 16 << 20).unwrap();
        let (first, other, key) = (id(), id(), format!("map|{}", id()));
        let mut r = Room::new(
            "Former ruler".into(),
            first.clone(),
            2,
            Value::Null,
            json!({"app":"general-connect"}),
        );
        r.persistent = true;
        r.players.extend([first.clone(), other.clone()]);
        r.start = json!({"players":[first,other],"key":key,"countries":{&first:"fr",&other:"de"},
            "names":{&first:"Former ruler",&other:"Other"},"avatarImages":{&first:"private-image",&other:"other-image"},
            "avatarSeeds":{&first:"private-seed"},"playerRatings":{&first:2500}});
        r.state = pack(&json!({"version":1,"key":key,"orders":[[first,[]],[other,["action"]]],
            "world":{"version":1,"game":{"year":7,"humanOrder":[2,1],"nations":[{"ruler":"Other"},{"ruler":"Former ruler","emoji":"private-emoji"}]}}})).unwrap();
        let old = r.state.clone();
        anonymize(&mut r, &first, "Current ruler").unwrap();
        store.save(&r).unwrap();
        let r = store.load(&r.id, true).unwrap().unwrap();
        let header = r.header().to_string();
        let save = unpack(&r.state).unwrap();
        for private in [
            &*first,
            "Former ruler",
            "private-image",
            "private-seed",
            "private-emoji",
        ] {
            assert!(!header.contains(private) && !save.to_string().contains(private));
        }
        assert_ne!(r.owner, first);
        assert_eq!(r.start["players"], json!([r.owner, other]));
        assert_eq!(r.start["countries"][&r.owner], "fr");
        assert_eq!(r.start["avatarImages"][&other], "other-image");
        assert_eq!(
            save["world"]["game"]["nations"],
            json!([{"ruler":"Other"},{"ruler":"Player"}])
        );
        assert_eq!(save["world"]["game"]["year"], 7);
        assert_eq!(save["orders"], json!([[other, ["action"]]]));
        assert!(current_save(&r.state, &r.start["key"]));
        assert!(!current_save(&old, &r.start["key"]));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
