import { Server } from "./Server";
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
    this.roomName = name || 'Room'
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

  sendToRoom(msg:any){
    this.playerIds.forEach(plId => {
      const player = Server.instance.players[plId]
      if(!player){ return }

      player.ws.send(
        JSON.stringify(msg)
      )
    })
  }

  removePlayer(pl:Player){
    pl.roomId = null;
    const playerIdx = this.playerIds.indexOf(pl.playerId)
    if(playerIdx === -1){ return }

    this.playerIds.splice(playerIdx, 1)
    this.sendToRoom({
      method: 'playerLeft',
      data: pl.playerId
    })

    if(this.ownerId !== pl.playerId){ return }
    
    if(this.playerIds.length > 0){
      this.ownerId = this.playerIds[0]
      this.sendToRoom({
        method: 'newRoomOwner',
        data: this.ownerId
      })
    } else {
      delete Server.instance.rooms[this.roomId]
    }
  }

  addPlayer(pl:Player, password:string|null){
    if(this.playerIds.includes(pl.playerId)){
      pl.ws.send(
        JSON.stringify({
          method: 'error',
          data: { text: 'Already in this room', code: "already_in_room" }
        })
      )
      return
    }
    if(pl.roomId && pl.roomId !== this.roomId){
      pl.ws.send(
        JSON.stringify({
          method: 'error',
          data: { text: 'Leave other room first', code: "in_other_room" }
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

    this.sendToRoom({
      method: 'playerEnter',
      data: pl.playerId
    })
    
    this.playerIds.push(pl.playerId)
    pl.roomId = this.roomId
    pl.ws.send(
      JSON.stringify({
        method: 'onRoomEnter',
        data: this.toNetObject()
      })
    )
  }

}