const cors = require('cors');
const { Address, Bn, Br, Tx } = require('bsv');
const { EventEmitter } = require('events');
const express = require('express');
const http = require('http');
const createError = require('http-errors');
const { NotFound } = createError;
const { Forge } = require('txforge');
const { SignedMessage } = require('@kronoverse/tools/lib/signed-message');

const agents = new Map();
const events = new EventEmitter();
events.setMaxListeners(100);
const txns = new Map();
const unspent = new Map();
const spends = new Map();
const jigs = new Map();
const messagesByTo = new Map();
const utxosByAddress = new Map();
const messages = new Map();
function indexJig(jigData) {
    jigs.set(jigData.location, jigData);
    events.emit('jig', jigData)
}

const app = express();
const server = http.createServer(app);
const io = require('socket.io').listen(server);
app.enable('trust proxy');
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
    if(exp.debug) console.log('REQ:', req.url);
    next();
});

app.get('/', (req, res) => {
    res.json(true);
});

app.get('/_ah/stop', (req, res) => {
    res.json(true);
    process.exit(0);
})

app.get('/_ah/warmup', (req, res) => {
    res.json(true);
});

app.get('/initialize', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
        res.json(exp.initialized);
        next();
    } catch (e) {
        next(e);
    }
});

app.post('/broadcast', async (req, res, next) => {
    try {
        const { rawtx } = req.body;
        const tx = new Tx().fromBr(new Br(Buffer.from(rawtx, 'hex')));
        const txid = tx.id();
        const ts = Date.now();

        // const txOutMap = new TxOutMap();
        const utxos = tx.txIns.map((txIn, i) => {
            const loc = `${new Br(txIn.txHashBuf).readReverse().toString('hex')}_o${txIn.txOutNum}`;
            const utxo = unspent.get(loc);
            if (!utxo) throw createError(422, `Input missing: ${i} ${loc}`);
            // const txOut = new TxOut({ valueBn: new Bn(utxo.satoshis, 10) });
            // txOut.setScript(new Script().fromBuffer(Buffer.from(utxo.script, 'hex')));
            // txOutMap.set(tx.txIns[i].txHashBuf, tx.txIns[i].txOutNum, txOut);
            return utxo;
        });
        // const verifier = new TxVerifier(tx, txOutMap);
        // if (!verifier.verify()) throw createError(422, 'Validation failed');

        txns.set(txid, rawtx);
        events.emit('txn', txid);
        utxos.forEach(async (utxo, i) => {
            spends.set(utxo.loc, txid);
            unspent.delete(utxo.loc);
            const userUtxos = utxosByAddress.get(utxo.address);
            if(userUtxos) userUtxos.delete(utxo.loc);
        });

        tx.txOuts.forEach((txOut, index) => {
            if (!txOut.script.isPubKeyHashOut()) return;
            const loc = `${txid}_o${index}`;
            const utxo = {
                loc,
                txid,
                index,
                vout: index,
                script: txOut.script.toBuffer().toString('hex'),
                address: new Address().fromTxOutScript(txOut.script).toString(),
                satoshis: txOut.valueBn.toNumber(),
                ts
            };
            unspent.set(loc, utxo);
            events.emit('utxo', utxo);
            if(!utxosByAddress.has(utxo.address)) {
                utxosByAddress.set(utxo.address, new Map());
            }
            utxosByAddress.get(utxo.address).set(utxo.loc, utxo);
        });

        res.json(txid);
    } catch (e) {
        next(e);
    }
});

app.get('/tx/:txid', async (req, res, next) => {
    try {
        const { txid } = req.params;
        const rawtx = txns.get(txid);
        if (!rawtx) throw new NotFound();
        res.send(rawtx);
    } catch (e) {
        next(e);
    }
});

app.get('/utxos/:address', async (req, res, next) => {
    try {
        const { address } = req.params;
        const userUtxos = utxosByAddress.get(address);
        if(userUtxos) {
            res.json(Array.from(userUtxos.values()));
        } else {
            res.json([]);
        }
    } catch (e) {
        next(e);
    }
});

app.post('/spent', async (req, res, next) => {
    try {
        const { locs } = req.body;
        const out = locs.map(loc => spends.get(loc) || '');
        res.json(out);
    } catch (e) {
        next(e);
    }
});

app.get('/spent/:loc', async (req, res, next) => {
    try {
        const { loc } = req.params;
        res.send(spends.get(loc) || '');
    } catch (e) {
        next(e);
    }
});

app.get('/fund/:address', async (req, res, next) => {
    try {
        const { address } = req.params;
        const { satoshis } = req.query;
        const ts = Date.now();
        const forge = new Forge({
            inputs: [],
            outputs: [
                { data: [Math.random().toString()] },
                { to: address, satoshis: satoshis || 100000000 },
            ]
        });
        forge.build();
        const tx = forge.tx;
        const txid = tx.id();
        txns.set(txid, tx.toHex());
        tx.txOuts.forEach(async (txOut, index) => {
            if (!txOut.script.isPubKeyHashOut()) return;
            const loc = `${txid}_o${index}`;
            const utxo = {
                loc,
                txid,
                index,
                vout: index,
                script: txOut.script.toBuffer().toString('hex'),
                address: new Address().fromTxOutScript(txOut.script).toString(),
                satoshis: txOut.valueBn.toNumber(),
                ts
            };
            unspent.set(loc, utxo);
            if(!utxosByAddress.has(utxo.address)) {
                utxosByAddress.set(utxo.address, new Map());
            }
            utxosByAddress.get(utxo.address).set(utxo.loc, utxo);
            events.emit('utxo', utxo);
        });

        res.json(true);
    } catch (e) {
        next(e);
    }
});


app.get('/agents/:realm/:agentId', (req, res) => {
    const agent = agents.get(req.params.agentId);
    if (!agent) throw new NotFound();
    res.json(agent);
});

app.get('/jig/:loc', async (req, res, next) => {
    try {
        // const jig = await run.load(req.params.loc)
        res.json(Array.from(jigs.values()).find(jig => jig.location === req.params.loc));
    } catch (e) {
        next(e);
    }
});

app.get('/jigs/:address', async (req, res, next) => {
    try {
        const { address } = req.params;
        if(!utxosByAddress.has(address)) return res.json([]);
        const locs = Array.from(utxosByAddress.get(address).keys());
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
            if(!messagesByTo.has(to)) {
                messagesByTo.set(to, new Map());
            }
            messagesByTo.get(to).set(message.id, message);
        })
        events.emit('message', message);
        res.json(true);
    } catch (e) {
        next(e);
    }
});

function publish(res, id, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n`);
    res.write(`id: ${id}\n\n`);
}

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
    const lastId = parseInt(req.headers['last-event-id'], 10);
    if(lastId) {
        if(utxosByAddress.has(channel)) {
            Array.from(utxosByAddress.get(channel).keys()).forEach(loc => {
                const jig = jigs.get(loc);
                if(!jig || jig.ts < lastId) return;
                publishJig(jig);
            })
        }
        if(messagesByTo.has(channel)) {
            Array.from(messagesByTo.get(channel).values()).forEach(message => {
                if(message.ts < lastId) return;
                publishMessage(message);
            })
        }
    }

    function publishJig(jigData) {
        if(jigData.owner === channel) {
            publish(res, jigData.ts, 'jig', jigData);
        }
    }

    function publishUtxo(utxo) {
        if(utxo.address === channel) {
            publish(res, utxo.ts, 'utxo', utxo);
        }
    }

    function publishMessage(message) {
        if(message.to.includes(channel)) {
            publish(res, message.ts, 'msg', message);
        }
    }

    events.on('jig', publishJig);
    events.on('utxo', publishUtxo);
    events.on('message', publishMessage);

    res.on('close', () => {
        clearInterval(interval);
        events.off('jig', publishJig);
        events.off('utxo', publishUtxo);
        events.off('message', publishMessage);
    });
});

app.use((err, req, res, next) => {
    console.error(err.message, err.statusCode !== 404 && err.stack);
    res.status(err.statusCode || 500).send(err.message);
});

async function listen(port) {
    return new Promise((resolve, reject) => {
        server.listen(port, (err) => {
            if (err) return reject(err);
            console.log(`App listening on port ${port}`);
            console.log('Press Ctrl+C to quit.');
            resolve();
        })
    })
}

const exp = module.exports = {
    debug: false,
    agents,
    events,
    indexJig,
    listen,
    initialized: false
};
