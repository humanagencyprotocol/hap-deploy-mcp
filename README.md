# @humanagencyp/deploy-mcp

Deploy MCP server — make already-built software live, under bounded human authority.

Implements the executor side of the [Human Agency Protocol](https://humanagencyprotocol.org)
`deploy@0.7` profile. Backend: **GitHub Actions**.

## What it does

Exposes releasing as gated tools so an agent can put software in front of real
users **only** with a signed receipt behind it. It does not decide whether a
release is allowed — that is the Gatekeeper's job, and then the pipeline's.

**The gated action is a release, not a build.** Building harms nobody: a preview
at a URL nobody visits has no consequence. Serving it does. So this server never
builds — it activates a build that already exists, which means a human can
*open it and look* before approving, and no rebuild can diverge from what was
approved.

| Tool | Kind | |
|---|---|---|
| `list_deployments` | read | builds that can be released, **with their URLs** |
| `get_deployment` | read | one build, with URL and state |
| `resolve_ref` | read | branch/tag → commit SHA |
| `list_environments` | read | the repo's real environments |
| `release` | consequential | make an existing build live |

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

**Not** `Contents: write`. This server releases builds that already exist; it
never authors or builds anything.

## Two properties that are easy to lose

**1. `release` declares `receipt_id`.** That declaration is what makes a Suveren
gateway inject the receipt it just minted. Remove it and the pipeline has
nothing to verify — the chain quietly degrades to an unproven release. The tool
refuses to dispatch when the field is missing, so the failure is loud.

**2. A build URL is required, not a commit or branch.** `release` rejects
anything that is not a URL. The receipt binds that exact build — the same bytes
a human inspected. Call `list_deployments` first.

Deployment URLs come from GitHub's Deployments API, which hosts with a GitHub
integration (Vercel, Netlify, Render) populate with `environment_url`. **So this
server never needs the host's credentials** — GitHub already knows the address,
and that one value identifies the artifact, shows the human what they are
approving, and is what the host's promote command accepts.

## The pipeline must verify

Dispatching is not the control point — anyone with repository write access can
dispatch a workflow. **The workflow itself must check the receipt** before
serving anything:

```yaml
on:
  workflow_dispatch:
    inputs:
      deployment_url: { required: true }
      receipt_id:     { required: true }
      environment:    { required: true }

jobs:
  verify:            # signature, action is a release, freshness,
                     # and that the receipt BINDS THIS BUILD
    ...
  release:
    needs: verify
    steps:
      - run: vercel promote "${{ inputs.deployment_url }}" --token "$VERCEL_TOKEN"
```

Nothing is built here. `promote` re-points production at bytes that already
exist, so what goes live is exactly what was inspected.

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
