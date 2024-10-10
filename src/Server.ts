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

  public players:playersObj = {}
  public lobby = new Lobby()
  public rooms:roomsObj = {}

  constructor(){
    if(!!Server.instance){
      throw new Error("Server has already started")
    }
    Server.instance = this
    this.wsServer = new WebSocket.Server({ port: 3333 })

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
          const r = Server.instance.rooms[pl.roomId || ""]
          if(!r) return;
          
          r.sendBinaryToOthers(message, pl.playerId)
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
        } else if(Date.now() - lastMsgTime > 10000){
          pl.send({ method: "Ping" })
        }
      }, 10000)
    })

    logMessage("server started")
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
    const handler = MessageHandler[msg.method]
    if(handler){
      handler(pl, msg.data)
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
    const id = loginParams.get("id")
    const password = loginParams.get("password")
    
    if(!id || !this.players[id]){
      const pl = new Player(name, id, null, ws)
      pl.send({
        method: 'accountCreated',
        data: { name: pl.playerName, id: pl.playerId, password: pl.password }
      })
      this.players[pl.playerId] = pl
      return pl
    } 
      
    const oldPlayer = this.players[id]
    if(oldPlayer){
      if(oldPlayer.password === password) {
        oldPlayer.playerName = name
        oldPlayer.ws = ws
        return oldPlayer
      }
      return null
    } 
    
    const newPlayer = new Player(name, id, password, ws)
    this.players[newPlayer.playerId] = newPlayer
    return newPlayer
  }

}