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
  
  private wsServer:WebSocket.Server

  public players:playersObj = {}
  public lobby = new Lobby()
  public rooms:roomsObj = {}

  constructor(){
    this.wsServer = new WebSocket.Server({ port: 8080 })

    this.wsServer.on('connection', (ws, req) => {
      const pl = this.authPlayer(ws, req.url || '')

      if(!pl){
        console.log('someone connected', req.url)
        ws.send(JSON.stringify({
          method: 'message',
          data: `Wrong login params`
        }))
        ws.close()
      } else {
        ws.on('message', message => {
          console.log(`Received message => ${message}`)
          
          const msg = JSON.parse(message.toString())
          this.onGetMessage(pl, msg)
        })
        ws.on('error', e => {
          console.log('socket error', e)
        })
        ws.on('close', () => {
          console.log('connection closed')
          console.log('@@@', ws.readyState)
        })
      }
      
    })
  }

  onGetMessage(pl:Player, msg:any){
    switch(msg.method){
      case "getRooms":
        pl.ws.send(JSON.stringify({
          method: 'onGetRooms',
          data: Object.values(this.rooms).map(r => ({
            id: r.roomId,
            players: r.playersId
          }))
        }))
        return
      case "getPlayers":
        pl.ws.send(JSON.stringify({
          method: 'onGetPlayers',
          data: Object.values(this.players).map( pl => ({
            id: pl.playerId,
            name: pl.playerName
          }) )
        }))
        return
    }
  }

  authPlayer(ws:WebSocket, url:string):Player | null {
    //url: /?player=apxapob&token=abc
    const loginParams = new URLSearchParams(url.substr(1))
    const playerName = loginParams.get("player")
    const token = loginParams.get("token")
    if(!playerName || !token){ return null }

    let pl:Player = this.players[token]
    
    if(pl){
      ws.send(JSON.stringify({
        method: 'message',
        data: `Hi again, ${playerName}!`
      }))
      pl.ws = ws
    } else {
      pl = new Player(playerName, token, ws)
      this.players[token] = pl
      ws.send(JSON.stringify({
        method: 'message',
        data: `Hi, ${playerName}!`
      }))
    }
    console.log('connected', pl.playerName)
    return pl
  }

}