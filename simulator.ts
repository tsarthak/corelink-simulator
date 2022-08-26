// Timing stuff
let currentTime = 0.0;
const events: Array<[number, () => void]> = [];
let eventTimer: number | undefined;

function schedule() {
  events.sort((a, b) => a[0] - b[0]);
  if(eventTimer !== undefined) {
    clearTimeout(eventTimer);
    eventTimer = undefined;
  }
  if(events.length > 0) {
    const nextEvent = events[0];
    eventTimer = setTimeout(
      () => {
        currentTime = nextEvent[0];
        nextEvent[1]();
        events.splice(0, 1);
        schedule();
      },
      Math.max(0, nextEvent[0] - currentTime),
    );
  }
}

function sleep(duration: number): Promise<void> {
  const targetTime = currentTime + duration;
  return new Promise((resolve, reject) => {
    events.push([targetTime, resolve]);
    schedule();
  });
}

function addTimeout(func: () => void, duration: number) {
  const targetTime = currentTime + duration;
  events.push([targetTime, func]);
  schedule();
}

// Simulation stuff
let control: Control;

interface Peer {
  name: string;
  position: [number, number];
  connections: {[id: string]: Connection};

  latency(): number;
}

async function rpc(source: Peer, target: Peer, method: string, ...args: any[]) {
  // Measure latency between source and target
  const dx = source.position[0] - target.position[0];
  const dy = source.position[1] - target.position[1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  const latency = dist + source.latency() + target.latency();

  // Wait to simulate travel time of packet
  await sleep(latency * 20);

  // Call target function
  const result = await (target as unknown as any)[method](...args);

  // Wait to simulate travel time back
  await sleep(latency * 20);

  // Return
  return result;
}

interface Connection {
  id: number;
  source: Peer;
  target: Peer;
  streamId: number;
}

const connections: {[id: string]: Connection} = {};
let nextConnectionId = 0;

function addStreamConnection(source: Peer, target: Peer, streamId: number) {
  const id = nextConnectionId++;
  const connection = {id, source, target, streamId};
  connections[id] = connection;
  source.connections[id] = connection;
  target.connections[id] = connection;
  draw();
}

class Client implements Peer {
  name: string;
  position: [number, number];
  connections: {[id: string]: Connection};

  publishedStream?: number;

  latency(): number {
    return 20;
  }

  constructor(name: string, position: [number, number]) {
    this.name = name;
    this.position = position;

    this.connections = {};
  }

  async findHomeRelay(): Promise<Relay> {
    // Get the list of relays from control
    const availableRelays = await control.listRelays();

    // Ping them
    const pingPromises = [];
    for(const relay of availableRelays) {
      pingPromises.push(this.ping(relay));
    }
    const pings = await Promise.all(pingPromises);

    // Pick the lowest ping
    pings.sort((a, b) => a[1] - b[1]);
    return pings[0][0];
  }

  async ping(relay: Relay): Promise<[Relay, number]> {
    const start = currentTime;
    await rpc(this, relay, 'ping');
    return [relay, currentTime - start];
  }

  async publishStream(streamId: number) {
    const homeRelay = await this.findHomeRelay();

    // Establish stream
    addStreamConnection(this, homeRelay, streamId);
  }

  async subscribeStream(streamId: number) {
    const homeRelay = await this.findHomeRelay();

    // TODO
  }

  async shutdown() {
    // Remove from the clients
    const idx = clients.findIndex(c => c.name === this.name);
    if(idx !== undefined) {
      clients.splice(idx, 1);
    }

    // Remove the connections
    for(const connection of Object.values(this.connections)) {
      let other;
      if(connection.source === this) {
        other = connection.target;
      } else {
        other = connection.source;
      }
      delete other.connections[connection.id];
      delete connections[connection.id];
    }
  }
}

class Relay implements Peer {
  name: string;
  position: [number, number];
  connections: {[id: string]: Connection};
  zone: string;

  constructor(name: string, position: [number, number], zone: string) {
    this.name = name;
    this.position = position;
    this.zone = zone;

    this.connections = {};
  }

  latency(): number {
    return 2;
  }

  async ping(): Promise<void> {
  }
}

abstract class Control {
  abstract listRelays(): Relay[];
}

// Scenario
const relays = [
  new Relay('us-ny-1', [90, 80], 'us-ny'),
  new Relay('us-ny-2', [90, 85], 'us-ny'),
  new Relay('us-az-1', [50, 95], 'us-az'),
  new Relay('us-az-2', [55, 95], 'us-az'),
];

const clients: Client[] = [];
const streams: number[] = [];
let nextStreamId = 0;

// Simulation
function addClients() {
  let redraw = false;

  // 20% chance of adding a client
  if(clients.length < 100 && Math.random() < 0.2) {
    const name = 'client-' + Math.floor(Math.random() * 10000);
    console.log("Creating " + name);
    const client = new Client(
      name,
      [5 + Math.random() * 90, 5 + Math.random() * 90],
    );
    clients.push(client);

    // 20% chance it wants to publish, 80% chance it wants to subscribe
    if(streams.length === 0 || Math.random() < 0.2) {
      // Publish a stream
      const streamId = nextStreamId++;
      client.publishedStream = streamId;
      console.log(name + " will publish " + streamId);
      streams.push(streamId);
      client.publishStream(streamId);
    } else {
      // Subscribe to a stream
      const streamId = streams[Math.floor(Math.random() * streams.length)];
      console.log(name + " will subscribe " + streamId);
      client.subscribeStream(streamId);
    }

    redraw = true;
  }

  // 15% chance of removing a client
  if(clients.length > 5 && Math.random() < 0.15) {
    const idx = Math.floor(Math.random() * clients.length);
    const client = clients[idx];
    console.log("Shutting down " + client.name);
    if(client.publishedStream !== undefined) {
      const streamIdx = streams.findIndex((s) => s === client.publishedStream);
      if(streamIdx !== undefined) {
        console.log("Shutting down stream " + client.publishedStream);
        streams.splice(streamIdx, 1);
      }
    }
    client.shutdown();

    redraw = true;
  }

  if(redraw) {
    draw();
  }

  addTimeout(addClients, 1000);
}
addTimeout(addClients, 1000);

// Control logic
interface ControlRelay {}

class ControlImpl extends Control {
  relays: {[name: string]: ControlRelay};
  streams: {[id: string]: {firstRelay: string}};

  constructor() {
    super();
    this.relays = {};
    this.streams = {};
  }

  listRelays(): Relay[] {
    // TODO: Pick one relay per zone
    return relays;
  }
}

control = new ControlImpl();

// Rendering
function draw() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, width, height);

  // Compute amount of traffic between peers
  const traffic: {[key: string]: {source: Peer; target: Peer; amount: number}} = {};
  for(const connection of Object.values(connections)) {
    const key = connection.source.name + ':' + connection.target.name;
    if(traffic[key] === undefined) {
      traffic[key] = {source: connection.source, target: connection.target, amount: 0};
    }
    traffic[key].amount += 1;
  }

  // Draw links
  for(const link of Object.values(traffic)) {
    let source = [link.source.position[0] / 100 * width, link.source.position[1] / 100 * height];
    let target = [link.target.position[0] / 100 * width, link.target.position[1] / 100 * height];

    // Move each endpoint to the side, to make way for the reverse link
    let dx = target[0] - source[0];
    let dy = target[1] - source[1];
    let len = Math.sqrt(dx * dx + dy * dy);
    dx /= len;
    dy /= len;
    source[0] += dy * 10;
    source[1] -= dx * 10;
    target[0] += dy * 10;
    target[1] -= dx * 10;

    ctx.lineWidth = link.amount;
    ctx.beginPath();
    ctx.moveTo(source[0], source[1]);
    ctx.lineTo(target[0], target[1]);
    ctx.stroke();
    ctx.lineWidth = 1;

    // Draw the arrow
    ctx.beginPath();
    ctx.moveTo(target[0] - dx * 5 + dy * 5, target[1] - dy * 5 - dx * 5);
    ctx.lineTo(target[0], target[1]);
    ctx.lineTo(target[0] - dx * 5 - dy * 5, target[1] - dy * 5 + dx * 5);
    ctx.stroke();
  }

  // Draw relays
  ctx.fillStyle = 'blue';
  for(const relay of relays) {
    ctx.fillText(relay.name, relay.position[0] / 100.0 * width, relay.position[1] / 100.0 * height);
  }

  // Draw clients
  ctx.fillStyle = 'red';
  for(const client of clients) {
    ctx.fillText(client.name,  client.position[0] / 100.0 * width, client.position[1] / 100.0 * height);
    if(client.publishedStream !== undefined) {
      ctx.fillText('' + client.publishedStream, client.position[0] / 100.0 * width, client.position[1] / 100.0 * height + 12);
    }
  }

  const info = document.getElementById('info')!;
  info.innerHTML = clients.length + ' clients, ' + streams.length + ' streams, ' + Object.values(connections).length + ' connections';
}

window.addEventListener('resize', draw);
draw();
