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
ws://localhost:8080/?name=$myPlayerName&id=$myId&password=$myPassword
```

### Server commands:
- getRooms - get open rooms list. No data.
- changeName - change player name. Data: new name string.
- createRoom - create new room. Data: { name: "room name", maxPlayers: number, password: string or null, gameData: object or null}
- enterRoom - enter selected room. Data: { id:"roomId", password: "room password" }
- leaveRoom - leave current room. No data.
- getPlayers - get selected players data. Data: array of players ids.
- sendChatMsg - send chat message to current room. Data: any string.
- startGame - starts game, after this no new players can enter this room. No data.
- shareGameState - can be used only by room owner for sharing full game state with other players in room. Data: any object.
- sendToRoom - send any data to other players in room. Data: any object
- sendTo - send any data to selected player in room. Data: { to:"playerId", msg:{...any object} }

### Messages from server:
- onConnected - after successfull connection.
- roomCreated - Data: object with created room information
- onGetRooms - Data: array with available rooms information
- onRoomEnter - when successfully entered room. Data: room info
- accountCreated - when someone connects without credentials server creates new account. Data: { name: playerName, id: playerId, password: password }
- onGetPlayers - Data: array of players
- playerEnter - when another player enters current room. Data: new player info
- error - when smth goes wrong. Data: { text: 'erroe text', code: "error code" }
- playerLeft - when someone lefts current room. Data: playerId
- nameChanged - when someone changes name. Data: { name: new name, id: playerId }
- newGameState - when room ownes shares game state. Data: any object
- messageFromPlayer - when someone sends you game data. Data: { from: playerId, msg: any object }
- chatMsg - chat message. Data: { text: any string, from: playerId }
- gameStarted - when game starts. No data.
- playerDisconnected - Data: playerId
- playerReconnected - Data: player information
- newRoomOwner - when owner lefts room server appoints a new room owner. Data: ownerId
