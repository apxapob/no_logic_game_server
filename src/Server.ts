import WebSocket from "ws"
import { Lobby } from "./Lobby"
import { MessageHandler } from "./MessageHandler"
import { Player } from "./Player"
import { Room } from "./Room"
import { logMessage } from "."

type playersObj = {
  [key: string]: Player;
}
type roomsObj = {
  [key: string]: Room;
}

export class Server {
  public static instance:Server

  private wsServer:WebSocket.Server
  
  public DevMode:boolean
  public SendDelay:number

  public players:playersObj = {}
  public lobby = new Lobby()
  public rooms:roomsObj = {}

  constructor(DevMode:boolean, SendDelay:number){
    if(!!Server.instance){
      throw new Error("Server has already started")
    }
    this.DevMode = DevMode
    this.SendDelay = SendDelay
    Server.instance = this
    this.wsServer = new WebSocket.Server({ port: 8080 })

    this.wsServer.on('connection', (ws, req) => {
      const pl = this.registerPlayer(ws, req.url || '')
      logMessage('new connection: ' + pl?.playerName)

      if(pl === null){
        ws.send(
          JSON.stringify({ method: 'wrongPassword' })
        )
        ws.close()
        return
      }

      pl.send({
        method: 'onConnected',
        data: {
          online: this.wsServer.clients.size
        }
      })

      let lastMsgTime = Date.now()
      ws.on('message', (message, isBinary) => {
        if(isBinary){
          if(this.DevMode){
            console.log("binary message:", (message as Buffer).length, 'bytes from', pl.playerName, "(" + pl.playerId + ")")
          }

          const r = Server.instance.rooms[pl.roomId || ""]
          if(!r) {
            console.log("Can't broadcast binary message: Player", pl.playerName, "(" + pl.playerId + ") not in room.")
            return
          }

          if(this.DevMode && this.SendDelay > 0){
            setTimeout(() => r.sendBinaryToOthers(message, pl.playerId), this.SendDelay)
          } else {
            r.sendBinaryToOthers(message, pl.playerId)
          }
          
        } else {
          const msg = JSON.parse(message.toString())
          this.onGetMessage(pl, msg)
        }
        lastMsgTime = Date.now()
      })
      ws.on('error', e => logMessage('socket error', e))
      ws.on('close', () => {
        this.onPlayerLeave(pl)

        pl.ws = null
        logMessage(pl.playerName + ' disconnected')
        clearInterval(intervalId)
      })

      const intervalId = setInterval(() => {
        if(Date.now() - lastMsgTime > 50000){
          logMessage(pl.playerName + ' is not answering')
          ws.close()
          clearInterval(intervalId)
          return
        } 
        pl.send({
          method: "Ping",
          data: Date.now()
        })
      }, 10000)
    })

    logMessage("server started")
    if(this.DevMode && this.SendDelay > 0){
      logMessage("send delay:", this.SendDelay, 'ms')
    }
  }

  stop(...args:any){
    // @ts-ignore
    Server.instance = null
    this.wsServer.close()
    this.wsServer.removeAllListeners()
    logMessage("server stopped", ...args)
  }

  onPlayerLeave(pl:Player){
    const room = this.rooms[pl.roomId || '']
    if(!room){return}

    if(room.gameStarted){
      room.playerDisconnected(pl)
    } else {
      room.removePlayer(pl)
    }
  }

  onGetMessage(pl:Player, msg:any){
    if(this.DevMode){
      console.log("Got message:", msg, "from", pl.playerName + " (" + pl.playerId + ")")
    }

    const handler = MessageHandler[msg.method]
    if(handler){
      if(this.DevMode && this.SendDelay > 0){
        setTimeout(() => handler(pl, msg.data), this.SendDelay)
      } else {
        handler(pl, msg.data)
      }
    } else {
      logMessage("unknown message:", msg)
    }
  }

  broadcast(msg:any){
    const json = JSON.stringify(msg)
    this.wsServer.clients.forEach(
      ws => ws.send(json)
    )
  }

  broadCastToLobby(msg:any){
    const json = JSON.stringify(msg)
    for (const playerId in this.players) {
      if (!this.players[playerId].roomId) {
        this.players[playerId].sendString(json)
      }
    }
  }

  enterRoom(pl:Player, roomId:string, password:string|null){
    const r:Room = this.rooms[roomId]
    if(!r){
      pl.send({
        method: 'error',
        data: { text: 'No such room', code: "no_room" }
      })
      return
    }
    if(r.gameStarted){
      r.reconnectPlayer(pl)
    } else {
      r.addPlayer(pl, password)
    }
  }

  registerPlayer(ws:WebSocket, url:string):Player|null {
    const loginParams = new URLSearchParams(url.substr(1))
    const name = loginParams.get("name") || ("Player " + (Date.now()%1296).toString(36).toUpperCase())
    const playerId = loginParams.get("playerId")
    const password = loginParams.get("password")

    if(!playerId || !this.players[playerId]){
      const pl = new Player(name, playerId, null, ws)
      pl.send({
        method: 'accountCreated',
        data: { name: pl.playerName, playerId: pl.playerId, password: pl.password }
      })
      this.players[pl.playerId] = pl
      return pl
    }

    const oldPlayer = this.players[playerId]
    if(oldPlayer){
      if(oldPlayer.password === password) {
        oldPlayer.playerName = name
        oldPlayer.ws = ws
        return oldPlayer
      }
      return null
    }

    const newPlayer = new Player(name, playerId, password, ws)
    this.players[newPlayer.playerId] = newPlayer
    return newPlayer
  }
}