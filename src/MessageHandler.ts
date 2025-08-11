import { Player } from "./Player"
import { Room } from "./Room"
import { Server } from "./Server"

type handlerObj = {
  [key: string]: (pl:Player, data:any) => void
}

const getRoomsJSON = (playerId:string) => ({
  method: 'onGetRooms',
  data: Object.values(Server.instance.rooms)
              .filter(r => !r.gameStarted || r.playerIds.includes(playerId))
              .map(r => r.toNetObject())
})

const getPlayersJSON = (playerIds?:string[]) => ({
  method: 'onGetPlayers',
  data: Object.values(Server.instance.players)
              .filter(pl => !playerIds || playerIds.includes(pl.playerId))            
              .map(pl => pl.toNetObject())
              .sort((a, b) => {
                if (a.roomEntryTimestamp === null || b.roomEntryTimestamp === null) {
                  return 0;
                }
                return a.roomEntryTimestamp - b.roomEntryTimestamp;
              })
})

export const MessageHandler:handlerObj = {
  Pong: (pl:Player, data:number) => {
    const currentTime = Date.now()
    pl.rtt = currentTime - data
  },
  getRooms: (pl:Player) => pl.send(getRoomsJSON(pl.playerId)),
  changeName: (pl:Player, data:string) => {
    pl.playerName = data
    const r = Server.instance.rooms[pl.roomId || ""]
    if(!r) return
    r.sendToRoom({
      method: 'nameChanged',
      data: { name: pl.playerName, playerId: pl.playerId }
    })
  },
  enterRoom: (pl:Player, data:{ roomId:string, password:string }) => Server.instance.enterRoom(pl, data.roomId, data.password),
  leaveRoom: (pl:Player) => Server.instance.onPlayerLeave(pl),
  getPlayers: (pl:Player, data?:string[]) => pl.send(getPlayersJSON(data)),
  sendChatMsg: (pl:Player, data:string) => {
    const r = Server.instance.rooms[pl.roomId || ""]
    if(!r) return
    r.sendToRoom({
      method: 'chatMsg',
      data: { text: data, from: pl.playerId }
    })
  },
  startGame: (pl:Player, data:any) => {
    Server.instance.rooms[pl.roomId || ""]?.startGame(pl, data)
  },
  requestGameState: (pl:Player) => {
    const r = Server.instance.rooms[pl.roomId || ""]
    if(!r || !r.ownerId) return

    const roomOwner = Server.instance.players[r.ownerId]

    roomOwner?.send({
      method: 'gameStateRequested',
      data: pl.toNetObject()
    })
  },
  shareGameState: (pl:Player, data:{ gamestate:any, to:string[] }) => {
    const r = Server.instance.rooms[pl.roomId || ""]
    if(!r || r.ownerId !== pl.playerId) return

    if(data.to){
      data.to.forEach(playerId => {
        if(!r.playerIds.includes(playerId)){ return }
      
        const toPlayer = Server.instance.players[playerId]
    
        toPlayer?.send({
          method: 'newGameState',
          data: data.gamestate
        })
      })
    } else {
      r.sendToOthers({
        method: 'newGameState',
        data: data.gamestate
      }, pl.playerId)
    }
  },
  sendToRoom: (pl:Player, data:any) => {
    const r = Server.instance.rooms[pl.roomId || ""]
    if(!r) return

    r.sendToOthers({
      method: 'messageFromPlayer',
      data: { from: pl.playerId, msg: data }
    }, pl.playerId)
  },
  sendTo: (pl:Player, data:{ to:string[], msg:any }) => {
    const r = Server.instance.rooms[pl.roomId || ""]
    if(!r) return

    const { to, msg } = data

    to?.forEach(playerId => {
      if(!r.playerIds.includes(playerId)){ return }
    
      const toPlayer = Server.instance.players[playerId]
  
      toPlayer?.send({
        method: 'messageFromPlayer',
        data: { from: pl.playerId, msg }
      })
    })
  },
  createRoom: (pl:Player, data:{ name:string, maxPlayers:number, password?:string, gameData:any }) => {
    const newRoom = new Room(data.name, pl.playerId, data.maxPlayers, data.password, data.gameData)
    Server.instance.rooms[newRoom.roomId] = newRoom
    Server.instance.enterRoom(pl, newRoom.roomId, newRoom.password)
    Server.instance.broadCastToLobby({
      method: 'roomCreated',
      data: newRoom.toNetObject()
    })
  },
  setRoomMeta: (pl:Player, data:any) => {
    const r = Server.instance.rooms[pl.roomId || ""]
    if (!r || r.ownerId !== pl.playerId) return

    r.roomMeta = data
    r.sendToRoom({
      method: 'onSetRoomMeta',
      data: r.roomMeta
    })
  }
}
