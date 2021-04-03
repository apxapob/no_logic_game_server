import { Player } from "./Player"
import { Room } from "./Room";
import { Server } from "./Server"

type handlerObj = {
  [key: string]: (pl:Player, data:any) => void;
};

const getRoomsJSON = () => ({
  method: 'onGetRooms',
  data: Object.values(Server.instance.rooms)
              .map(r => r.toNetObject())
})

const getPlayersJSON = (playerIds:Array<string>) => ({
  method: 'onGetPlayers',
  data: Object.values(Server.instance.players)
              .map(pl => pl.toNetObject())
              .filter(pl => playerIds.includes(pl.id))
})

export const MessageHandler:handlerObj = {
  getRooms: (pl:Player) => pl.send(getRoomsJSON()),
  enterRoom: (pl:Player, data:any) => Server.instance.enterRoom(pl, data.id, data.password),
  leaveRoom: (pl:Player) => Server.instance.onLeaveRoom(pl),
  getPlayers: (pl:Player, data:any) => pl.send(getPlayersJSON(data || [])),
  sendChatMsg: (pl:Player, data:any) => {
    const r = Server.instance.rooms[pl.roomId || ""]
    if(!r) return
    r.sendToRoom({
      method: 'chatMsg',
      data: { text: data, from: pl.playerId }
    })
  },
  createRoom: (pl:Player, data:any) => {
    const newRoom = new Room(data.name, pl.playerId, data.maxPlayers, data.password);
    Server.instance.rooms[newRoom.roomId] = newRoom;
    Server.instance.enterRoom(pl, newRoom.roomId, newRoom.password);
    Server.instance.broadcast({
      method: 'roomCreated',
      data: newRoom.toNetObject()
    })
  }
}
