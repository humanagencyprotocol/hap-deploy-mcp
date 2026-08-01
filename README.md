# @humanagencyp/deploy-mcp

Deploy MCP server — run deployment pipelines under bounded human authority.

Implements the executor side of the [Human Agency Protocol](https://humanagencyprotocol.org)
`deploy@0.6` profile. Backend: **GitHub Actions**.

## What it does

Exposes deployment as gated tools so an agent can ship software **only** with a
signed receipt behind it. It does not decide whether a deploy is allowed — that
is the Gatekeeper's job, and then the pipeline's.

| Tool | Kind | |
|---|---|---|
| `resolve_ref` | read | branch/tag → commit SHA |
| `list_deployments` | read | recent workflow runs |
| `get_deployment` | read | one run |
| `list_environments` | read | the repo's real environments |
| `deploy` | consequential | dispatch a pipeline for one commit |

## Setup

```
GITHUB_TOKEN=<fine-grained token>
```

Fine-grained, scoped to **one repository**:

| Permission | Why |
|---|---|
| Actions: read & write | dispatch the workflow |
| Environments: read | list environments for the authorization wizard |
| Contents: read | resolve a branch to a commit |

**Not** `Contents: write`. This server ships commits that already exist; it never
authors them.

## Two properties that are easy to lose

**1. `deploy` declares `receipt_id`.** That declaration is what makes a Suveren
gateway inject the receipt it just minted. Remove it and the pipeline has
nothing to verify — the chain quietly degrades to an unproven deploy. The tool
refuses to dispatch when the field is missing, so the failure is loud.

**2. A commit is required, not a branch.** `deploy` rejects `main`. A receipt
binds one commit; authorising "deploy main" would authorise whatever `main`
happens to be when the action finally runs, which may not be what was reviewed.
Call `resolve_ref` first.

## The pipeline must verify

Dispatching is not the control point — anyone with repository write access can
dispatch a workflow. **The workflow itself must check the receipt** before
releasing anything:

```yaml
on:
  workflow_dispatch:
    inputs:
      sha:        { required: true }
      receipt_id: { required: true }
      environment: { required: true }

jobs:
  verify:                       # signature, scope, commit binding, freshness
    ...
  deploy:
    needs: verify
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ inputs.sha }}   # the APPROVED commit, not the branch head
```

Building the branch head instead of `inputs.sha` means a receipt for one commit
can ship another — and the receipt still verifies, certifying something false.
That is worse than having no receipt at all.

## Limits, stated plainly

- This server dispatches; it does not hold the deploy credentials the pipeline
  uses. The boundary is the receipt requirement, not the whole path.
- GitHub returns no run id from a dispatch, so the run is matched by workflow
  and creation time. Best-effort: it reports no run rather than guessing wrong.

## Licence

MIT
