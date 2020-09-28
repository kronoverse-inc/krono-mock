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

const agents = new Map();
const events = new EventEmitter();
events.setMaxListeners(100);
const jigs = new Map();
const messages = new Map();

const network = 'mock';
const purse = 'cVCMJJPrh2ayqQ2625nDaw72f9FrzssGpaCPaTgL8cfdHBnsKBWi';
const owner = 'cNsH7M3EnyS2eNkAG9cqG99nTNGuu9Ssun48iPzGg5MBMMPAivRd';

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
        const txid = await run.blockchain.broadcast(rawtx);
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

app.get('/spent/:loc', async (req, res, next) => {
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
        const txid = await run.blockchain.fund(address, satoshis);
        res.send(txid);
    } catch (e) {
        next(e);
    }
});

app.get('/agents/:realm/:agentId', (req, res) => {
    const agent = agents.get(req.params.agentId);
    if (!agent) throw new NotFound();
    res.json(agent);
});

app.get('/jigs/:address', async (req, res, next) => {
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

app.get('/sse/:channel', async (req, res, next) => {
    const { channel } = req.params;
    req.socket.setNoDelay(true);
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store; no-cache; max-age=0; stale-while-revalidate=0; stale-if-error=0",
        "Connection": "keep-alive"
    });

    res.write('retry: 1000\n\n');

    const interval = setInterval(() => res.write('data: \n\n'), 15000);
    const lastId = parseInt(req.headers['last-event-id'] || req.query.lastEventId, 10);
    if (lastId && channels.has(channel)) {
        Array.from(channels.get(channel).entries())
            .filter(id => id > lastId)
            .forEach(([id, { event, data }]) => publish(id, event, data));
    }

    function publish(id, event, data) {
        if (exp.debug) console.log('EVENT:', channel, id, event, JSON.stringify(data));
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n`);
        res.write(`id: ${id}\n\n`);
    }

    events.on(channel, publish)

    res.on('close', () => {
        clearInterval(interval);
        events.off(channel, publish);
    });
});

app.get('/txns', async (req, res, next) => {
    res.json(await Promise.all(txns.map(txid => server.blockchain.fetch(txid))));
});

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
    debug: false,
    agents,
    blockchain,
    events,
    listen,
    close,
    initialized: false,
    run,
    jigs,
    txns,
    indexJigs: true
};

if(exp.indexJigs) {
    const run = new Run({
        network,
        blockchain,
        owner,
        purse,
        cache,
        timeout: 30000,
        trust: '*',
        // logger: console
    });

    blockchain.events.on('txn', async (rawtx) => {
        blockchain.block();
        const tx = Tx.fromHex(rawtx);
        const txid = tx.id();
        const ts = Date.now();
        txns.push(txid);

        tx.txOuts.forEach((txOut, index) => {
            if (!txOut.script.isPubKeyHashOut()) return;
            const utxo = {
                loc: `${txid}_o${index}`,
                txid,
                index,
                vout: index,
                script: txOut.script.toBuffer().toString('hex'),
                address: new Address().fromTxOutScript(txOut.script).toString(),
                satoshis: txOut.valueBn.toNumber(),
                ts
            };

            publishEvent(utxo.address, 'utxo', utxo);
        });

        let payload;
        try {
            payload = run.payload(rawtx);
        } catch (e) {
            if (e.message.includes('Bad payload structure') || e.message.includes('Not a run transaction')) return;
            throw e;
        }
        const locs = payload.out.map((x, i) => `${txid}_o${i + 1}`);
        await indexJig(locs.shift());
        await Promise.all(locs.map((loc) => indexJig(loc)));
    });

    async function indexJig(loc) {
        if (!loc) return;
        try {
            console.log('Indexing:', loc);
            const jig = await run.load(loc).catch(e => {
                if (e.message.includes('Jig does not exist') ||
                    e.message.includes('Not a run transaction')
                ) return;
                throw e;
            });
            if (!jig) return;
            console.log('JIG:', jig.constructor.name, jig.location);
            const jigData = {
                location: jig.location,
                kind: jig.constructor && jig.constructor.origin,
                type: jig.constructor.name,
                origin: jig.origin,
                owner: jig.owner,
                ts: Date.now(),
                isOrigin: jig.location === jig.origin
            };
            jigs.set(jigData.location, jigData);
            publishEvent(jigData.owner, 'jig', jigData);
            publishEvent(jigData.kind, 'jig', jigData);
            publishEvent(jigData.origin, 'jig', jigData);
        } catch (e) {
            console.error('INDEX ERROR:', e);
            // throw e;
        }
    }    
}