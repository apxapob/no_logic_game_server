import WebSocket from "ws"
import { Lobby } from "./Lobby"
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
        console.log(`Received message => ${message}`)
        
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

  getPlayersJSON(){
    return JSON.stringify({
      method: 'onGetPlayers',
      data: Object.values(this.players)
                  .map(pl => pl.toNetObject())
    })
  }

  getRoomsJSON(){
    return JSON.stringify({
      method: 'onGetRooms',
      data: Object.values(this.rooms)
                  .map(r => r.toNetObject())
    })
  }

  onLeaveRoom(pl:Player){
    if(pl.roomId){
      const room = this.rooms[pl.roomId]
      if(room){ room.removePlayer(pl) }
    }
  }

  onGetMessage(pl:Player, msg:any){
    switch(msg.method){
      case "getRooms":
        pl.ws.send(this.getRoomsJSON())
        return
      case "enterRoom":
        this.enterRoom(pl, msg.data.id, msg.data.password);
        return
      case "leaveRoom":
        this.onLeaveRoom(pl)
        return
      case "getPlayers":
        pl.ws.send(this.getPlayersJSON())
        return
      case "createRoom":
        const newRoom = new Room(msg.data.name, pl.playerId, msg.data.maxPlayers, msg.data.password);
        this.rooms[newRoom.roomId] = newRoom;
        this.enterRoom(pl, newRoom.roomId, newRoom.password);
        this.broadcast({
          method: 'roomCreated',
          data: newRoom.toNetObject()
        })
        return
    }
  }

  broadcast(msg:any){
    this.wsServer.clients.forEach(
      ws => ws.send( JSON.stringify(msg) )
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