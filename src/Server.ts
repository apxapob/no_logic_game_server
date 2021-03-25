import WebSocket from "ws"
import { Lobby } from "./Lobby"
import { Player } from "./Player"
import { Room } from "./Room"

export class Server {
  
  private wsServer:WebSocket.Server

  public players:Map<string, Player> = new Map<string, Player>()
  public lobby = new Lobby()
  public rooms:Map<string, Room> = new Map<string, Room>()

  constructor(){
    this.wsServer = new WebSocket.Server({ port: 8080 })

    this.wsServer.on('connection', (ws, req) => {

      const pl = this.authPlayer(ws, req.url || '')

      ws.on('message', message => {
        console.log('@@', ws.readyState)
        console.log(`Received message => ${message}`)
      })
      ws.on('error', e => {
        console.log('socket error', e)
      })
      ws.on('close', () => {
        console.log('connection closed')
        console.log('@@@', ws.readyState)
      })

      
      if(!pl){
        console.log('someone connected', req.url)
        ws.send(JSON.stringify({
          method: 'message',
          data: `Wrong login params`
        }))
        ws.close()
      }
      
    })
  }

  authPlayer(ws:WebSocket, url:string):Player | null {
    //url: /?player=apxapob&token=abc
    const loginParams = new URLSearchParams(url.substr(1))
    const playerName = loginParams.get("player")
    const token = loginParams.get("token")
    if(!playerName || !token){ return null }

    let pl = this.players.get(playerName+"_"+token)
    
    if(pl){
      ws.send(JSON.stringify({
        method: 'message',
        data: `Hi again, ${playerName}!`
      }))
      pl.ws = ws
    } else {
      pl = new Player(playerName, token, ws)
      this.players.set(playerName+"_"+token, pl)
      ws.send(JSON.stringify({
        method: 'message',
        data: `Hi, ${playerName}!`
      }))
    }
    console.log('connected', pl.playerName)
    return pl
  }

}