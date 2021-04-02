import WebSocket from "ws"
import { Lobby } from "./Lobby"
import { MessageHandler } from "./MessageHandler";
import { Player } from "./Player"
import { Room } from "./Room"

type playersObj = {
  [key: string]: Player;
};
type roomsObj = {
  [key: string]: Room;
};

export class Server {
  public static instance:Server
  
  private wsServer:WebSocket.Server

  public players:playersObj = {}
  public lobby = new Lobby()
  public rooms:roomsObj = {}

  constructor(){
    Server.instance = this
    this.wsServer = new WebSocket.Server({ port: 8080 })

    this.wsServer.on('connection', (ws, req) => {
      const pl = this.registerPlayer(ws, req.url || '')

      ws.on('message', message => {
        console.log(`${pl.playerName}: ${message}`)
        
        const msg = JSON.parse(message.toString())
        this.onGetMessage(pl, msg)
      })
      ws.on('error', e => {
        console.log('socket error', e)
      })
      ws.on('close', () => {
        this.onLeaveRoom(pl)
        
        delete this.players[pl.playerId]
        console.log(pl.playerName + ' disconnected')
      })
    })
  }

  onLeaveRoom(pl:Player){
    if(pl.roomId){
      const room = this.rooms[pl.roomId]
      if(room){ room.removePlayer(pl) }
    }
  }

  onGetMessage(pl:Player, msg:any){
    const handler = MessageHandler[msg.method]
    if(handler){
      handler(pl, msg.data)
    } else {
      console.log("unknown message")
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
      pl.ws.send(
        JSON.stringify({
          method: 'error',
          data: { text: 'No such room', code: "no_room" }
        })
      )
      return
    }
    r.addPlayer(pl, password)
  }

  registerPlayer(ws:WebSocket, url:string):Player {
    //url: /?name=apxapob
    const loginParams = new URLSearchParams(url.substr(1))
    const name = loginParams.get("name") || "Player"
    
    let pl = new Player(name, ws)
    this.players[pl.playerId] = pl

    ws.send(
      JSON.stringify({
        method: 'accountCreated',
        data: { name: pl.playerName, id: pl.playerId }
      })
    )

    return pl
  }

}