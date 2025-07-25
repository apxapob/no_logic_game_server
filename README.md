# No Logic Game Server
Simple server for games with logic on client.

## Installation
Download source or clone this repository.
Install all the dependencies:
```bash
// with npm
npm install

// with yarn
yarn install
```
Run the server:
```bash
// with npm
npm run start

// with yarn
yarn run start
```
Open demo.html in 2 browser tabs. If game starts then everything is ok.

## API
Server sends and receives json strings of this format
```js
{
  method: "methodName",
  data: {...method parameters}
}
```

## Connect to server
First time client must connect without credentials. 
Like this:
```
ws://localhost:8080/
```
Server will create a new account and send its data to client.
After this client can connect with credentials like this:
```
ws://localhost:8080/?name=$myPlayerName&playerId=$myId&password=$myPassword
```

### Server commands:
- getRooms - get open rooms list. No data.
- changeName - change player name. Data: new name string.
- createRoom - create new room. Data: { name: "room name", maxPlayers: number, password: string or null, gameData: object or null}
- enterRoom - enter selected room. Data: { roomId:"roomId", password: "room password" }
- leaveRoom - leave current room. No data.
- getPlayers - get selected players data. Data: array of players ids.
- sendChatMsg - send chat message to current room. Data: any string.
- startGame - starts game, after this no new players can enter this room. No data.
- shareGameState - can be used only by room owner for sharing full game state with other players. 
Data: { 
  gamestate: any object, 
  to: list of player ids(optional)
}
- sendToRoom - send any data to other players in room. Data: any object
- sendTo - send any data to selected player in room. Data: { to:"playerId", msg:{...any object} }
- Pong - Data: server timestamp in milliseconds.


### Messages from server:
- onConnected - after successfull connection.
- roomCreated - Data: object with created room information
- roomDeleted - Data - roomId
- roomBlock - when game started and no more players can enter this room. Data - roomId
- onGetRooms - Data: array with available rooms information
- onRoomEnter - when successfully entered room. Data: room info
- accountCreated - when someone connects without credentials server creates new account. Data: { name: playerName, playerId: playerId, password: password }
- onGetPlayers - Data: array of players
- playerEnter - when another player enters current room. Data: new player info
- error - when smth goes wrong. Data: { text: 'error text', code: "error code" }
- playerLeft - when someone lefts current room. Data: playerId
- nameChanged - when someone changes name. Data: { name: new name, playerId: playerId }
- newGameState - when room ownes shares game state. Data: any object
- messageFromPlayer - when someone sends you game data. Data: { from: playerId, msg: any object }
- chatMsg - chat message. Data: { text: any string, from: playerId }
- gameStarted - when game starts. No data.
- playerDisconnected - Data: playerId
- newRoomOwner - when owner lefts room server appoints a new room owner. Data: ownerId
- RoomRTT - Data: dictionary with RTT values for all players in the room
- Ping - Server sends Ping message to all clients every 10 seconds, to check if they are still connected. Data: server timestamp in milliseconds. You need to respond to this message with Pong message and send back the same timestamp for correct RTT(Round Trip Time) measurement.





