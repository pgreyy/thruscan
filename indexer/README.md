# The indexer

Reads the chain once so the site never has to.

Every "reading the chain…" message on ThruScan is a round trip somebody is
waiting on. A page showing twenty tokens makes twenty of them before it can
draw anything, and no amount of tidying the front end fixes that, because the
waiting is real. This walks the chain continuously, decodes what it finds, and
writes rows. The site then reads rows, which answer in milliseconds, and only
talks to the chain at the moment it is about to send a transaction.

It is also the activity feed. An activity feed is a list of what happened on
chain in order, and this is a thing that follows the chain and records what
happened in order, so both come out of the same job.

## Running it

```
node indexer/index.mjs                     follow the chain, forever
node indexer/index.mjs --once              catch up to the head and exit
node indexer/index.mjs --from 18600        start at a slot
node indexer/index.mjs --to 18700          stop at a slot
node indexer/index.mjs --show 20           print the newest rows and exit
```

`THRU_RPC` picks the network and defaults to betanet. Nothing else is required.

## Where it puts things

SQLite by default, in `indexer/index.db`. Node 22 ships SQLite in its standard
library, so this installs nothing and needs nothing running, which is most of
the reason it is the default: the fewer moving parts, the more likely this is
still running in six months.

Set `DATABASE_URL` to a Postgres connection string and it uses that instead.
That is what a hosted indexer will want.

## Where it has to run

Not on Vercel. Vercel runs a function when a request arrives and stops it when
the response is sent, and this has to keep running between requests. It needs a
small always-on machine. That is a real running cost, a modest one, and the
first one ThruScan has had.

## Restarting is safe

The cursor moves in the same database transaction as the rows it covers, so a
crash can repeat work but can never skip it, and every insert ignores conflicts
on the signature, so repeated work costs nothing. Kill it at any moment.

## Addresses

Thru's own programs sit at the same address on every network, because the
runtime places them there. Ours do not: a program's address comes from whoever
deployed it, so ThruScan's programs have one set on alphanet and will have a
different set on betanet. `addresses.mjs` holds both, keyed by network, and any
of them can be overridden with an environment variable so the betanet deploy
needs no code change.

Getting this wrong does not throw. It quietly labels everything "Program call",
which is why an unrecognised network prints a warning rather than guessing.

## Tests

```
node --test indexer/decode.test.mjs
```

The decoder is tested against transactions built by hand rather than against a
chain, and deliberately so. Betanet currently carries nothing but the node's
own keepalive traffic and alphanet is down, so running the loop end to end
proves the loop works and proves nothing about whether a launchpad buy is read
as a buy.
