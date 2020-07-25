const cors = require('cors');
const { Address, Bn, Br, Tx } = require('bsv');
const { EventEmitter } = require('events');
const express = require('express');
const http = require('http');
const createError = require('http-errors');
const { Forbidden, HttpError, NotFound } = createError;
const { Forge } = require('txforge');
const { SignedMessage } = require('krono-tools/lib/signed-message');

const agents = new Map();
const events = new EventEmitter();
events.setMaxListeners(100);
const txns = new Map();
const unspent = new Map();
const spends = new Map();
const jigs = new Map();
const messages = new Map();
const paymails = new Map();
function indexJig(jigData) {
    jigs.set(jigData.location, jigData);
    io.to(jigData.owner).emit('jig', jigData);
}

let initialized;
function setInitializer(initializer) {
    initialized = initializer;
}

const app = express();
const server = http.createServer(app);
const io = require('socket.io').listen(server);
app.enable('trust proxy');
app.use(cors());
app.use(express.json());


io.on('connection', socket => {
    socket.on('register', (message) => {
        // TODO: Verify message
        socket.join(message.from);
        console.log(`${message.from} listening`);
    });

    socket.on('address', (address) => {
        // TODO: Verify message
        socket.join(address);
        console.log(`${address} listening`);
    });
 });

app.use((req, res, next) => {
    if(exp.debug) {
        console.log('REQ:', req.url);
    }
    next();
});

app.get('/', (req, res) => {
    res.json(true);
});

app.get('/_ah/warmup', (req, res) => {
    res.json(true);
});

app.get('/_ah/stop', (req, res) => {
    process.exit(0);
});

app.get('/initialize', async (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    try {
        await initialized;
        res.json(true);
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

        console.log('TX', txid);
        txns.set(txid, rawtx);
        events.emit('txn', txid);
        utxos.forEach(async (utxo, i) => {
            spends.set(utxo._id, txid);
            unspent.delete(utxo._id);
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
            io.to(utxo.address).emit('utxo', utxo);
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
        const utxos = Array.from(unspent.values()).filter(utxo => utxo.address === address);
        res.json(utxos);
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
        console.log('FUND:', address);
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
            events.emit('utxo', utxo);
            io.to(utxo.address).emit('utxo', utxo);
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

// app.post('/:agentId/event/:event', async (req, res, next) => {
//     try {
//         const { agentId, event } = req.params;

//         const action = {
//             ...req.body,
//             agentId,
//             event,
//             ts: Date.now()
//         };
//         events.emit('act', action);
//         res.json(true);
//     } catch (e) {
//         next(e);
//     }
// });

// app.post('/:agentId/submit', async (req, res, next) => {
//     try {
//         const { agentId } = req.params;

//         const action = {
//             ...req.body,
//             event: req.body.name,
//             agentId,
//             ts: Date.now()
//         };
//         events.emit('act', action);
//         res.json(true);
//     } catch (e) {
//         next(e);
//     }
// });

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
        const utxos = Array.from(unspent.values()).filter(utxo => utxo.address === address);
        const matching = utxos.map(utxo => jigs.get(utxo.loc)).filter(jig => jig);
        res.json(matching);
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
        // TODO: verify message sig
        messages.set(message.hash, message);
        message.to.forEach(to => io.to(to).emit('message', message));
        res.json(true);
    } catch (e) {
        next(e);
    }
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
    setInitializer
};
