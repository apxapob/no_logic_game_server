use regex::Regex;
use serde_json::Value;
// The protocol originated in JSON.parse/JSON.stringify. Normalize to IEEE-754
// numbers and use ECMAScript's shortest number spelling for byte quotas.
pub fn parse(text: &str) -> Result<Value, serde_json::Error> {
    fn normalize(v: &mut Value) {
        match v {
            Value::Number(n) => {
                if let Some(f) = n.as_f64() {
                    *v = if f.fract() == 0.0 && f >= 0.0 && f < (u64::MAX as f64) {
                        Value::from(f as u64)
                    } else if f.fract() == 0.0 && f >= i64::MIN as f64 && f < 0.0 {
                        Value::from(f as i64)
                    } else {
                        serde_json::Number::from_f64(f)
                            .map(Value::Number)
                            .unwrap_or(Value::Null)
                    }
                }
            }
            Value::Array(a) => {
                for v in a {
                    normalize(v)
                }
            }
            Value::Object(m) => {
                for v in m.values_mut() {
                    normalize(v)
                }
            }
            _ => {}
        }
    }
    let mut v = serde_json::from_str(text)?;
    normalize(&mut v);
    Ok(v)
}
pub fn stringify(v: &Value) -> String {
    fn write(v: &Value, out: &mut String) {
        match v {
            Value::Number(n) => out.push_str(ryu_js::Buffer::new().format(n.as_f64().unwrap())),
            Value::Array(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',')
                    }
                    write(v, out)
                }
                out.push(']')
            }
            Value::Object(m) => {
                out.push('{');
                for (i, (k, v)) in m.iter().enumerate() {
                    if i > 0 {
                        out.push(',')
                    }
                    out.push_str(&serde_json::to_string(k).unwrap());
                    out.push(':');
                    write(v, out)
                }
                out.push('}')
            }
            _ => out.push_str(&v.to_string()),
        }
    }
    let mut out = String::new();
    write(v, &mut out);
    out
}
use std::sync::LazyLock;
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        .unwrap()
});
static LANG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$").unwrap());
static EVENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.:\-]{1,128}$").unwrap());
static TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_:\-]{20,4096}$").unwrap());
pub fn uuid(v: &Value) -> bool {
    v.as_str().is_some_and(|s| UUID.is_match(s))
}
pub fn len(s: &str) -> usize {
    s.encode_utf16().count()
}
fn string(v: &Value, min: usize, max: usize, trim: bool) -> bool {
    v.as_str().is_some_and(|s| {
        len(s) <= max
            && len(if trim {
                s.trim_matches(js_whitespace)
            } else {
                s
            }) >= min
    })
}
fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn optional(v: &Value, k: &str, f: impl FnOnce(&Value) -> bool) -> bool {
    v.get(k).is_none_or(f)
}
fn password(v: &Value) -> bool {
    v.is_null() || string(v, 0, 128, false)
}
pub fn integer(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|n| (0.0..=9007199254740991.0).contains(&n) && n.fract() == 0.0)
}
fn ids(v: &Value, max: usize, unique: bool) -> bool {
    v.as_array().is_some_and(|a| {
        a.len() <= max
            && a.iter().all(uuid)
            && (!unique || a.iter().collect::<std::collections::HashSet<_>>().len() == a.len())
    })
}
fn translations(v: &Value) -> bool {
    v.as_object().is_some_and(|m| {
        m.len() <= 20
            && m.iter().all(|(k, v)| {
                LANG.is_match(k)
                    && string(&v["title"], 1, 100, true)
                    && string(&v["body"], 1, 500, true)
            })
    })
}
pub fn notice(v: &Value) -> bool {
    v.is_null()
        || (v.is_object()
            && v["eventId"].as_str().is_some_and(|s| EVENT.is_match(s))
            && integer(&v["at"])
            && ids(&v["to"], 64, false)
            && string(&v["title"], 1, 100, false)
            && string(&v["body"], 1, 500, false)
            && optional(v, "translations", translations))
}
fn bounded(v: &Value, d: usize) -> bool {
    d <= 32
        && match v {
            Value::Array(a) => a.iter().all(|v| bounded(v, d + 1)),
            Value::Object(a) => a.values().all(|v| bounded(v, d + 1)),
            _ => true,
        }
}
pub fn validate(v: &Value, room_max: usize, accounts: usize) -> bool {
    if !v.is_object() || !bounded(v, 0) {
        return false;
    }
    let d = &v["data"];
    let obj = d.is_object();
    let name = |v: &Value| string(v, 1, 64, true);
    let cap = |v: &Value| {
        integer(v) && v.as_f64().unwrap() >= 1.0 && v.as_f64().unwrap() <= room_max as f64
    };
    match v["method"].as_str().unwrap_or("") {
        "getModerationTicket" => {
            obj && uuid(&d["requestId"]) && uuid(&d["target"]) && uuid(&d["room"])
        }
        "getSavedRooms" => obj && ids(&d["ids"], 20, false),
        "getSession" => obj && uuid(&d["requestId"]),
        "getSessionChunk" => {
            obj && uuid(&d["requestId"]) && integer(&d["revision"]) && integer(&d["offset"])
        }
        "beginSession" => {
            obj && uuid(&d["requestId"])
                && integer(&d["revision"])
                && integer(&d["generation"])
                && integer(&d["size"])
                && d["size"].as_f64().unwrap() > 0.0
        }
        "commitSession" => {
            obj && uuid(&d["requestId"])
                && d.get("scheduled").is_some_and(notice)
                && d.get("immediate").is_some_and(notice)
        }
        "authenticate" => {
            obj && optional(d, "name", name)
                && optional(d, "playerId", uuid)
                && optional(d, "password", |v| string(v, 0, 128, false))
        }
        "Pong" => d.is_number(),
        "setPushDevice" => {
            obj && uuid(&d["deviceId"])
                && optional(d, "language", |v| {
                    v.as_str().is_some_and(|s| LANG.is_match(s))
                })
                && d["foreground"].is_boolean()
                && d.get("token").is_some()
                && (d["token"].is_null() || d["token"].as_str().is_some_and(|s| TOKEN.is_match(s)))
        }
        "notifyPlayers" => {
            obj && ids(&d["to"], accounts, true)
                && !d["to"].as_array().unwrap().is_empty()
                && d["eventId"].as_str().is_some_and(|s| EVENT.is_match(s))
                && string(&d["title"], 1, 100, true)
                && string(&d["body"], 1, 500, true)
                && optional(d, "translations", translations)
        }
        "getRooms" => d.is_null() || (obj && optional(d, "after", uuid)),
        "leaveRoom" | "requestGameState" | "openUdp" | "closeUdp" => d.is_null(),
        "getPlayers" => d.is_null() || ids(d, accounts, true),
        "changeName" => name(d),
        "sendChatMsg" => string(d, 0, 2048, false),
        "enterRoom" => obj && uuid(&d["roomId"]) && password(&d["password"]),
        "createRoom" => {
            obj && optional(d, "binaryRelay", Value::is_boolean)
                && name(&d["name"])
                && cap(&d["maxPlayers"])
                && password(&d["password"])
        }
        "updateRoom" => {
            obj && ["name", "maxPlayers", "password", "joinClosed"]
                .iter()
                .any(|k| d.get(k).is_some())
                && optional(d, "joinClosed", Value::is_boolean)
                && optional(d, "name", name)
                && optional(d, "maxPlayers", cap)
                && password(&d["password"])
        }
        "shareGameState" => {
            obj && d.get("gamestate").is_some() && optional(d, "to", |v| ids(v, accounts, true))
        }
        "sendTo" => obj && ids(&d["to"], accounts, true) && d.get("msg").is_some(),
        "startGame" | "sendToRoom" | "setRoomMeta" => v.get("data").is_some(),
        _ => false,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numbers_follow_ecmascript() {
        for (input, expected) in [
            ("4.0", "4"),
            ("1e-6", "0.000001"),
            ("1e21", "1e+21"),
            ("-0.0", "0"),
            ("9007199254740993", "9007199254740992"),
        ] {
            assert_eq!(stringify(&parse(input).unwrap()), expected);
        }
    }
    #[test]
    fn depth_and_undefined_fields_stay_bounded() {
        let mut v = serde_json::json!(0);
        for _ in 0..35 {
            v = serde_json::json!([v]);
        }
        assert!(!validate(
            &serde_json::json!({"method":"sendToRoom","data":v}),
            16,
            1024
        ));
        assert!(!validate(
            &serde_json::json!({"method":"setPushDevice","data":{"deviceId":crate::model::id(),"foreground":false}}),
            16,
            1024
        ));
    }
}
