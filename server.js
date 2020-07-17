const cors = require('cors');
const { Address, Bn, Br, Script, Tx, TxOut, TxOutMap, TxVerifier } =require('bsv');
const { EventEmitter } =require('events');
const express = require('express');
const http = require('http');
const createError = require('http-errors');
const { Forbidden, HttpError, NotFound } = createError;
const { Forge } =require('txforge');

// const Run = require('@runonbitcoin/release');

// const network = 'mock';

// const state = new MapStorage();
// const run = new Run({
//     network,
//     blockchain,
//     state
// });
// run.owner.next = () => run.owner.pubkey;

const agents = new Map();
const events = new EventEmitter();
events.setMaxListeners(100);
const txns = new Map();
const unspent = new Map();
const spends = new Map();
const channels = new Map();
const jigs = new Map();
function indexJig(jig) {
    jigs.set(jig.location, jig);
    events.emit('jig', jig);
}

// events.on('txn', async (tx) => {
//     if (!tx.outputs[0].script.isSafeDataOut()) {
//         return;
//     }

//     await Promise.all(tx.outputs.map(async (o, vout) => {
//         if (!o.script.isPublicKeyHashOut()) return;
//         const loc = `${tx.hash}_o${vout}`;
//         const jig = await run.load(loc).catch((e) => {
//             if (e.message.includes('not a run tx') ||
//                 e.message.includes('not a jig output') ||
//                 e.message.includes('Not a token')
//             ) return;
//             console.error('Load error:', e.message);
//         });
//         if (!jig) return;
//         console.log('JIG:', jig.constructor.name, jig.location);
//         const index = jigs.push({
//             location: jig.location,
//             kind: jig.constructor.origin || '',
//             type: jig.constructor.name,
//             origin: jig.origin,
//             owner: jig.owner,
//             ts: Date.now(),
//             isOrigin: jig.location === jig.origin
//         });
//         events.emit('jig', index - 1);
//     }));
// });

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

events.on('jig', (jig) => io.emit('jig', jig));
events.on('utxo', (utxo) => io.emit('utxo', utxo));
events.on('channel', (channel) => io.emit('channel', channel));

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
            channels.delete(utxo._id);
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
            events.emit('utxo', utxo);
            unspent.set(loc, utxo);
        });

        res.json(true);
    } catch (e) {
        next(e);
    }
});


app.get('/channel/:loc', async (req, res, next) => {
    try {
        const { loc } = req.params;
        const channel = channels.get(loc);
        if (!channel) throw new NotFound();
        res.json(channel);
    } catch (e) {
        next(e);
    }
});


app.post('/channel/:loc', async (req, res, next) => {
    try {
        const ts = Date.now();
        const { loc } = req.params;
        const { rawtx } = req.body;
        const tx = new Tx().fromBr(new Br(Buffer.from(rawtx, 'hex')));

        const txOutMap = new TxOutMap();

        const inputs = await Promise.all(tx.txIns.map(async (txIn, i) => ({
            address: new Address().fromTxInScript(txIn.script).toString(),
            loc: `${new Br(txIn.txHashBuf).readReverse().toString('hex')}_o${txIn.txOutNum}`,
            seq: txIn.nSequence,
            valid: false
        })));

        const idInput = inputs.find(i => i.loc === loc);

        await Promise.all(tx.txIns.map(async (txIn, i) => {
            const outTxId = new Br(txIn.txHashBuf).readReverse().toString('hex');
            const loc = `${outTxId}_o${txIn.txOutNum}`;
            const out = unspent.get(loc)
            if (!out) throw new Error(`Input missing: ${i} ${outTxId}-${txIn.txOutNum}`);
            const txOut = new TxOut({ valueBn: new Bn(out.satoshis, 10) });
            txOut.setScript(new Script().fromBuffer(Buffer.from(out.script, 'hex')));
            txOutMap.set(txIn.txHashBuf, txIn.txOutNum, txOut);
        }));
        const verifier = new TxVerifier(tx, txOutMap);

        if (!idInput || !idInput.valid) throw new Forbidden();
        await Promise.all(inputs.map(async (input, i) => {
            input.valid = await verifier.asyncVerifyNIn(i);
        }));

        const to = tx.txOuts
            .filter(txOut => txOut.script.isPublicKeyHashOut())
            .map((txOut) => new Address().fromTxOutScript(txOut.script).toString());

        const seq = idInput.seq;
        const channel = {
            loc,
            seq,
            rawtx,
            to,
            from: inputs.map(i => i.address),
            parties: Array.from(new Set([
                ...to,
                ...inputs.map(i => i.address)
            ])),
            locs: inputs.map(i => i.loc),
            seqs: inputs.map(i => i.seq),
            ts
        };

        channels.set(loc, channel);
        events.emit('channel', channel);
        res.json(true);
    } catch (e) {
        next(e);
    }
});

app.post('/:agentId/submit', async (req, res, next) => {
    try {
        const { agentId } = req.params;
        const { address } = agents.get(agentId);
        if (!address) throw new NotFound();

        const action = {
            ...req.body,
            address,
            ts: Date.now()
        };
        events.emit('act', action);
        res.json(true);
    } catch (e) {
        next(e);
    }
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
        const utxos = Array.from(unspent.values()).filter(utxo => utxo.address === address);
        res.json(Array.from(jigs.values()).filter(jig => utxos.find(utxo => utxo.loc == jig.location)));
    } catch (e) {
        next(e);
    }
});

app.post('/jigs/kind/:kind', async (req, res, next) => {
    try {
        const locs = Array.from(jigs.values()).filter(jig => jig.kind === req.params.kind)
            .map(jig => jig.location);
        res.json(locs);
    } catch (e) {
        next(e);
    }
});

app.post('/jigs/origin/:origin', async (req, res, next) => {
    try {
        const locs = Array.from(jigs.values()).filter(jig => jig.origin === req.params.origin)
            .map(jig => jig.location);
        res.json(locs);
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
            if(err) return reject(err);
            console.log(`App listening on port ${port}`);
            console.log('Press Ctrl+C to quit.');
            resolve();
        })
    })
}

module.exports = {
    agents,
    events,
    indexJig,
    listen,
    setInitializer
}

