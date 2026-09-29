# Running the indexer for the live site

The site works without any of this. `/api/activity` reads the chain directly
when there is no database behind it. This makes it fast and gives it history
further back than a few pages of recent transactions.

Three things have to exist: a Postgres database both the indexer and the site
can reach, the indexer running somewhere continuously, and one environment
variable on Vercel.

## 1. A database

Neon's free tier is the least trouble: no card, and it sleeps when idle.

1. In a browser, go to `neon.com` and sign up.
2. Create a project. Any name. Pick the region closest to you.
3. On the project page, copy the connection string. It looks like
   `postgresql://user:password@ep-something.eu-central-1.aws.neon.tech/neondb?sslmode=require`.

Keep that string out of the repo. It is a password.

## 2. The indexer, running somewhere

It has to run continuously, so it cannot live on Vercel: Vercel starts a
function when a request arrives and stops it when the response is sent.

**On your own PC, to try it:** in PowerShell, from `C:\projects\thruscan`:

```
$env:DATABASE_URL="<the connection string>"
$env:THRU_RPC="https://rpc.alphanet.thru.org"
node indexer/index.mjs
```

Leave that window open. It prints a line per batch of slots and then sits
saying it has caught up. Close the window and it stops; start it again and it
picks up exactly where it left off.

**Somewhere that stays up:** any small always-on host runs it. Railway and
Fly.io both have a free or near-free tier that suits a single process. The
command is `node indexer/index.mjs` and the environment is the same two
variables. Point it at the repo and it needs no build step.

## 3. Tell the site where the database is

In a browser, in the Vercel dashboard for thruscan: Settings, then Environment
Variables. Add `DATABASE_URL` with the same connection string, for Production.
Then redeploy, or push anything, so the new value is picked up.

That is all. `/api/activity` starts answering from Postgres, the feed gets
faster and deeper, and if the database ever goes away the endpoint falls back
to reading the chain on its own.

## Checking which one is answering

In a browser: `https://thruscan.xyz/api/activity?limit=1`. The reply carries a
`source` field, which reads `postgres`, `sqlite` or `chain`.

## What it costs

Nothing, on the free tiers, at this size. Every transaction is one short row
and Thru produces a handful per second at most today. Neon's free tier holds
far more than a year of that.
