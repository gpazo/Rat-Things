# Explore design directions with Session forks

Start with one prepared UI, fork it into independent directions, evaluate the
results, and choose the one worth continuing. The Fieldnotes video explores five:
**Paper & ink**, **After hours**, **Studio blue**, **Soft sage**, and **Index**.
Each inherits the same conversation and files, then develops its own design.

## Watch the demo

<video controls playsinline preload="none" style="width:100%;border-radius:12px" poster="https://gpazo.github.io/Rat-Things/assets/session-fork-demo-poster.jpg?v=five-forks-42s" src="https://gpazo.github.io/Rat-Things/assets/session-fork-demo.mp4?v=five-forks-42s" aria-label="Session fork demo: evaluate five design directions and keep one"></video>

[Watch or download the 42-second video](https://gpazo.github.io/Rat-Things/assets/session-fork-demo.mp4?v=five-forks-42s).
The video compares five generated designs, chooses one direction, and discards
the other children. Waiting periods are shortened. Each fork remains independent,
so continuing one does not change the others.

Music: Claude Debussy, *Clair de lune*, performed by Laurens Goedhart
([source](https://commons.wikimedia.org/wiki/File:Clair_de_lune_(Claude_Debussy)_Suite_bergamasque.ogg)),
licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Excerpted, faded,
and level-adjusted for the video.

Five is an example, not a fork limit. Each call to the fork endpoint creates one
independent child. Repeat it for the alternatives you want to explore, within your
deployment's capacity and quotas. The source briefly checkpoints for each copy,
so wait for its admission to reopen before creating another child from it.

## Try the same flow

[Open the two-direction interactive walkthrough](https://gpazo.github.io/Rat-Things/fork-demo/).
This compact companion compares Paper & ink with After hours. It uses prepared designs, makes
no AWS calls, and can be reset freely. The same interface also has a live mode that
creates real Sessions and shows their generated HTML artifacts.

## Run the walkthrough locally

From the repository root:

```bash
npm ci
npm run demo:fork
```

Open the loopback URL printed by the server. Prepare the starting point, fork the
two themes, compare them, and keep either direction. Download the selected design
as a self-contained HTML file, or start again to try the other path.

## Connect it to your deployment

Deploy the current runtime and API together, configure S3 Files, and set
`session_checkpoints_enabled = true`. The setting defaults to `false`. Use an AWS
principal authorized to invoke your deployment's token issuer and a model enabled
by that deployment. Live mode creates billed model and worker activity.

```bash
export AWS_REGION=us-west-2
export RAT_THINGS_AGENTS_API_URL="https://your-agents-api.example/v1"
export AGENT_MODEL="your-deployment-model-id"
npm run demo:fork -- --live
```

Use the printed `127.0.0.1` URL with `?mode=live`. AWS credentials and bearer tokens
stay in the local server; the page does not receive them. The server binds to
loopback and accepts mutations only from its own page. Keep it local.

1. **Prepare the starting point.** The demo creates an Agent and a managed Session,
   supplies the Fieldnotes HTML, and asks the agent to read and remember the brief.
2. **Explore both paths.** Each child is created through the fork endpoint. It
   inherits the original conversation and files, then changes its own copy. The
   source is checkpointed while copying and remains available for later input.
3. **Keep your favorite.** The demo deletes the other child Session. It shows the
   winning Session ID and offers its saved HTML for download. Continue that Session
   through the API or CLI; choosing a winner does not merge files into the source.

```bash
rat-things sessions send sess_your_winner --input "Add a pricing section in this style."
```

Configure the CLI with the same API URL and region. The winning Session and original
Session remain yours until you delete them. **Clean up demo sessions** deletes both
and the demo Agent, including any partially created branches after an error. Stopping
the local server alone preserves the Sessions.

## Recovery and previews

The server records the resources it creates in `.runtime/fork-demo/state.json`.
Restarting against the same deployment restores the demo. An interrupted operation
asks you to clean up before starting again. Use `FORK_DEMO_STATE_FILE` for a separate
demo inventory, and `FORK_DEMO_PORT` to choose another local port. Preserve the
inventory until cleanup completes. If a creation response is lost, inspect Sessions
with `metadata.demo = fieldnotes-fork` before removing abandoned resources.

The previews are saved `/workspace/outputs/index.html` artifacts from completed
Turns. They are shown in restricted frames with scripts and external assets disabled.
This demonstrates static generated UI; it is not a live dev-server relay. The downloaded
HTML is the generated artifact, so inspect it before publishing it elsewhere.

Forks start from the latest terminal root Turn, use managed persistent storage, and
copy at most 256 MiB. Public child Items and Turns start fresh; native context and
private recovery history are inherited. Credentials are prepared again for each
child, and optional permissions can only narrow. See [Session fork semantics](agents-api.md#fork-a-session).
