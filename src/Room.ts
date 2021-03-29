import { Player } from "./Player";

export class Room {
  public roomId:string = ''
  public ownerId:string = ''
  public roomName:string = ''
  public password:string|null = null
  public maxPlayers = 6
  public playerIds:Array<string> = []

  constructor(name:string, ownerId:string, maxPlayers = -1, password = null){
    this.roomId = Date.now().toString()
    this.ownerId = ownerId
    this.roomName = name
    this.password = password
    if(maxPlayers > 0){
      this.maxPlayers = maxPlayers
    }
  }

  toNetObject() {
    return {
      id: this.roomId,
      ownerId: this.ownerId,
      name: this.roomName,
      players: this.playerIds,
      maxPlayers: this.maxPlayers
    }
  }

  addPlayer(pl:Player, password:string|null){
    if(this.playerIds.indexOf(pl.playerId) !== -1){
      pl.ws.send(
        JSON.stringify({
          method: 'error',
          data: { text: 'Already in this room', code: "already_in_room" }
        })
      )
      return
    }
    if(this.playerIds.length >= this.maxPlayers){
      pl.ws.send(
        JSON.stringify({
          method: 'error',
          data: { text: 'This room is full', code: "full_room" }
        })
      )
      return
    }
    if(password !== this.password){
      pl.ws.send(
        JSON.stringify({
          method: 'error',
          data: { text: 'Wrong room password', code: "wrong_password" }
        })
      )
      return
    }
    
    this.playerIds.push(pl.playerId)
    pl.ws.send(
      JSON.stringify({
        method: 'onRoomEnter',
        data: this.toNetObject()
      })
    )
  }

}