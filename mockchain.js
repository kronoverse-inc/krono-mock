const Run = require('@kronoverse/tools/lib/run');
const { EventEmitter } = require('events');

class Mockchain extends Run.Mockchain {
    constructor() {
        super();
        this.mempoolChainLimit = Number.MAX_VALUE;
        this.events = new EventEmitter();
    }

    async broadcast(rawtx) {
        await super.broadcast(rawtx);
        this.events.emit('txn', rawtx);
    }

    async fund(address, satoshis) {
        const txid = await super.fund(address, satoshis);
        const rawtx = await this.fetch(txid);
        this.events.emit('txn', rawtx);
        return txid;
    }
}

module.exports = Mockchain;