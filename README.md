# n8n-nodes-vtiger-crm-v2

Community node for [n8n](https://n8n.io) to integrate with **VTiger CRM 6.x** through its [webservice REST API](https://community.vtiger.com/help/vtigercrm/developers/third-party-app-integration.html).

Successor of [`n8n-nodes-vtiger-crm`](https://github.com/sogjugz/n8n-nodes-vtiger-crm) with dynamic module/field metadata, picklist dropdowns, a visual query builder, inventory line-item handling and automatic pagination. Both packages can coexist in the same instance — this one registers as `VTiger CRM V2`.

## Operations

| Operation | VTiger API | Notes |
|---|---|---|
| Create | `create` | Validates required fields (from `describe`). |
| Update | `retrieve` + `update` | VTiger requires the full entity: the node fetches the record first, then merges only the fields you add. |
| Delete | `delete` | Accepts numeric ID or webservice ID (`12x345`). |
| Describe | `describe` | Module metadata: `idPrefix` for reference fields (e.g. `assigned_user_id` → `19x123`) and picklist `value`s vs translated `label`s — useful to know the exact values to filter by in Get Many conditions. |
| Get | `retrieve` | Fetch a single record by ID. |
| Get Many | `query` | Visual builder (fields, conditions, ORDER BY) or raw SQL-like query. Auto-paginates `LIMIT offset,100` when "Return All" is on. |

Field and module dropdowns are populated live from your instance (`listtypes` / `describe`). Required fields are marked with `*`.

### Inventory modules (Quotes, Invoice, SalesOrder, PurchaseOrder)

These modules require a `productid` matching the first `LineItems` entry. The node handles this automatically: `productid` is set to the product of the first line item, and at least one line item is required on create. On update, existing line items are preserved unless you provide new ones.

### Empty results

The node returns only the contents of VTiger's `result` field, not the `{success, result}` envelope. If a **Get Many** query returns no records, the node outputs **0 items** and downstream nodes will not run (n8n only executes a node when it receives at least one item).

To keep the workflow running on empty results, enable **Settings → Always Output Data** on the node — n8n will then emit a single empty item `{}` instead. You can guard downstream logic with `{{ Object.keys($json).length > 0 }}`.

## Credentials

- **Base URL**: only the root URL of your VTiger installation (e.g. `https://crm.example.com` or `https://example.com/vtigercrm` if installed in a subdirectory). Do **not** include `/webservice.php` or a trailing slash — the node appends the endpoint itself and strips trailing slashes automatically.
- **Username**: your VTiger login username
- **Access Key**: the webservice access key from *My Preferences* in VTiger (not your password)

Sessions are created via `getchallenge` + `login` and automatically renewed when they expire.

## Development

This project uses the official [`@n8n/node-cli`](https://www.npmjs.com/package/@n8n/node-cli) (`n8n-node`) toolchain:

```bash
npm install
npm run build     # n8n-node build — compile + copy assets
npm run lint      # n8n-node lint — official community nodes rules
npm run lint:fix  # auto-fix lint issues
npm run dev       # n8n-node dev — local n8n with the node loaded
```

## Test it locally

`npm run dev` builds the node, links it into a dedicated n8n user folder (`~/.n8n-node-cli/.n8n/custom`) and starts a local n8n at `http://localhost:5678` with hot reload.

> **Note:** since n8n 3.0, `n8n-node dev` runs n8n in a container, so it needs **Docker or Podman**. If you don't have either, run n8n yourself with npm and point the CLI at it:
>
> ```bash
> N8N_DEV_RELOAD=true npx n8n          # terminal 1: your own n8n instance
> n8n-node dev --external-n8n          # terminal 2: link + watch from the project dir
> ```

## Publishing

```bash
npm run release   # n8n-node release — build + lint + publish via release-it
```

Requires `npm login`. The package name must start with `n8n-nodes-` and include the `n8n-community-node-package` keyword (already set) to be installable from n8n's community nodes panel.
