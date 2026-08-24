# elia

- [`v1/`](v1/) — current stable line (mirrors `master`).
- [`v2/`](v2/) — active development line (this branch, `manus`), with the full autonomy/tooling stack: goal graphs, governor/policy layer, scheduler, browser & communication tool adapters, finance/data-science/spreadsheet/presentation/fitness/sports tools, task dashboard, action-contract verification, audit logging, and more.

Each folder is self-contained — its own `package.json`, `bun.lock`, `tsconfig.json`. Run `bun install` inside whichever one you're working in.

## Install v2

```bash
bun add --global @mdsahilmolla/elia
# or
npm install --global @mdsahilmolla/elia
```

Elia is open source under the [GNU Affero General Public License v3.0](LICENSE).
