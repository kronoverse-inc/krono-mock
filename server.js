const cors = require('cors');
const { Address, Br, Tx } = require('bsv');
const { EventEmitter } = require('events');
const express = require('express');
const http = require('http');
const createError = require('http-errors');
const { NotFound } = createError;
const Mockchain = require('./mockchain');

const Run = require('@kronoverse/tools/lib/run');
const { SignedMessage } = require('@kronoverse/tools/lib/signed-message');

const events = new EventEmitter();
events.setMaxListeners(100);
const jigs = new Map();
const messages = new Map();

const blockchain = new Mockchain();
blockchain.mempoolChainLimit = Number.MAX_VALUE;
const cache = new Run.LocalCache({ maxSizeMB: 100 });
const txns = [];

const channels = new Map();
function publishEvent(channel, event, data) {
    if (!channels.has(channel)) channels.set(channel, new Map());
    const id = Date.now();
    channels.get(channel).set(id, { event, data });
    events.emit(channel, id, event, data);
}

const app = express();
const server = http.createServer(app);

const WebSocket = require('ws');
const wss = new WebSocket.Server({ clientTracking: false, noServer: true });

const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

app.enable('trust proxy');
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
    if (exp.debug) console.log('REQ:', req.url);
    next();
});

app.get('/', (req, res) => {
    res.json(true);
});

app.get('/_ah/stop', (req, res) => {
    res.json(true);
    events.emit('shutdown');
})

app.get('/_ah/warmup', (req, res) => {
    res.json(true);
});

app.get('/initialize', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
        res.json(exp.initialized);
    } catch (e) {
        next(e);
    }
});

app.post('/broadcast', async (req, res, next) => {
    try {
        const { rawtx } = req.body;
        const txid = await blockchain.broadcast(rawtx);
        res.send(txid);
    } catch (e) {
        next(e);
    }
});

app.get('/tx/:txid', async (req, res, next) => {
    try {
        const { txid } = req.params;
        const rawtx = await blockchain.fetch(txid);
        if (!rawtx) throw new NotFound();

        res.send(rawtx);
    } catch (e) {
        next(e);
    }
});

app.get('/utxos/:script', async (req, res, next) => {
    try {
        const { script } = req.params;
        res.json(await blockchain.utxos(script));
    } catch (e) {
        next(e);
    }
});

app.get('/spends/:loc', async (req, res, next) => {
    try {
        const [txid, vout] = req.params.loc.split('_o');
        res.send(await blockchain.spends(txid, parseInt(vout, 10)));
    } catch (e) {
        next(e);
    }
});

app.get('/fund/:address', async (req, res, next) => {
    try {
        const { address } = req.params;
        const satoshis = parseInt(req.query.satoshis) || 100000000;
        const txid = await blockchain.fund(address, satoshis);
        res.send(txid);
    } catch (e) {
        next(e);
    }
});

app.get('/agents/:realm/:agentId', (req, res) => {
    const agent = exp.agents[req.params.agentId];
    if (!agent) throw new NotFound();
    res.json(agent);
});

app.get('/jigs', async (req, res, next) => {
    try {
        res.json(Array.from(jigs.values()));
    } catch (e) {
        next(e);
    }
});

app.get('/jigs/:loc', async (req, res, next) => {
    try {
        const { loc } = req.params;
        if(jigs.has(loc)) {
            return res.json(jigs.get(loc));
        }
        res.sendStatus(404);
    } catch (e) {
        next(e);
    }
});


app.get('/jigs/address/:address', async (req, res, next) => {
    try {
        const { address } = req.params;
        const script = Address.fromString(address).toTxOutScript().toHex();
        const utxos = await blockchain.utxos(script);
        const locs = utxos.map(u => `${u.txid}_o${u.vout}`);
        res.json(locs.map(loc => jigs.get(loc)).filter(jig => jig));
    } catch (e) {
        next(e);
    }
});

app.post('/jigs/kind/:kind', async (req, res, next) => {
    try {
        const matching = Array.from(jigs.values()).filter(jig => jig.kind === req.params.kind);
        res.json(matching);
    } catch (e) {
        next(e);
    }
});

app.post('/jigs/origin/:origin', async (req, res, next) => {
    try {
        const matching = Array.from(jigs.values()).filter(jig => jig.origin === req.params.origin);
        res.json(matching);
    } catch (e) {
        next(e);
    }
});

app.get('/messages/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        const message = messges.get(id);
        if (!message) throw new NotFound();
        res.json(message);

    } catch (e) {
        next(e);
    }
});

app.post('/messages', async (req, res, next) => {
    try {
        const message = new SignedMessage(req.body);
        messages.set(message.id, message);
        message.to.forEach((to) => {
            publishEvent(to, 'msg', message);
        });
        message.context.forEach(context => {
            publishEvent(context, 'msg', message);
        })

        publishEvent(message.subject, 'msg', message);
        res.json(true);
    } catch (e) {
        next(e);
    }
});

app.get('/state/:key', async (req, res, next) => {
    try {
        const { key } = req.params;
        const value = await cache.get(key);
        if (!value) throw new NotFound();
        res.json(value);
    } catch (e) {
        next(e);
    }
});

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', (ws, req) => {
    ws.on('message', (message) => {
        const { action, channelId } = JSON.parse(message);

        if (action !== 'subscribe') return;

        events.on(channelId, (id,event,data) => {
            ws.send(JSON.stringify({
                id,
                channel: channelId,
                event,
                data
            }));
        });
    });
});

app.use('/wallet',express.static(path.join(__dirname, 'ks-client')), (req,res,next) => {
    let pathToFile = path.join(__dirname, 'ks-client', "index.html");

    let data = fs.readFileSync(pathToFile);
    let cType = mime.lookup(pathToFile);

    res.writeHeader(200, { "Content-Type": cType });
    res.write(data);
    res.end();
});

app.get('/txns', async (req, res, next) => {
    res.json(await Promise.all(txns.map(txid => blockchain.fetch(txid))));
});

app.post('/:agentId', async (req, res, next) => {
    const agent = exp.agents[req.params.agentId];
    if(agent && agent.onMessage) {
        const result = await agent.onMessage(req.body);
        res.json(result);
    } else {
        res.sendStatus(204);
    }
})

app.use((err, req, res, next) => {
    console.error(err.message, err.statusCode !== 404 && err.stack);
    res.status(err.statusCode || 500).send(err.message);
});

async function listen(port) {
    return new Promise((resolve, reject) => {
        // const PORT = process.env.PORT || 8082;
        server.listen(port, (err) => {
            if (err) return reject(err);
            console.log(`App listening on port ${port}`);
            console.log('Press Ctrl+C to quit.');
            resolve();
        })
    })
}

async function close() {
    server.close();
}

const exp = module.exports = {
    debug: true,
    agents: {},
    blockchain,
    events,
    listen,
    close,
    initialized: false,
    jigs,
    txns,
    cache,
    publishEvent,
};

blockchain.events.on('txn', async (rawtx) => {
    blockchain.block();
    const tx = Tx.fromHex(rawtx);
    const txid = tx.id();
    txns.push(txid);
});


// Testing Stuff
// let PORT = process.env.MOCKPORT === undefined ? 3000 : process.env.MOCKPORT;

// (async () => {
//     app.listen(PORT,() => {
//         console.log(`Server listening on port ${PORT}`);
//     })
// })();