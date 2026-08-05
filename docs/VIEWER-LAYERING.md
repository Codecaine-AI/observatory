# Viewer layering

Viewer functionality in Observatory has three layers. The boundary is based on
whether behavior is common to kernel traces or depends on one harness's
application semantics.

## Three layers

Layer 0 is the shared viewer packages in `agent-kernel`: `viewer-core`,
`viewer-ui`, and `viewer-shell`. They own app-neutral behavior, including the
trace tree, span cards, detail shell, generic renderers, and prompt lab.
Application-specific behavior must not be hardcoded in these packages. The
`app:board-render` detail renderer was moved into Canvas's extension for this
reason. The package-boundary check rejects known app-specific references under
`agent-kernel/packages`.

Layer 1 is the Observatory host. It owns the project registry, routing,
per-project viewer mounting, extension loading, and fallback policy. It does
not interpret application events.

Layer 2 is each harness's `./viewer-extension` package. It contains only the
additions that depend on that harness's application semantics. In Extensions
v0, an extension exports a detail-block provider constructed with
`{ apiBase }`.

## Where a feature belongs

The default destination is the shared layer. Rendering for protocol-level
events, generic tool calls, prompts, or any other behavior that applies to the
traces of any kernel belongs in `viewer-ui` or `viewer-shell`, with shared data
and API contracts in `viewer-core`.

An extension is reserved for application semantics. Canvas board renders and
Canvas transcript-backed thinking, program, and render blocks are examples.

When two harnesses need the same extension behavior, that behavior moves into
the shared packages and both extensions remove it. Extensions are not a second
general-purpose viewer library.

## Override semantics

Extension detail-block providers are additive. They contribute blocks to the
built-in renderer's blocks; they do not replace the renderer or its view.

Block identifiers are unique within a view. When a provider returns the same
identifier more than once, the first block wins. When an extension identifier
collides with a built-in identifier, the built-in block wins because built-in
blocks are merged first.

A missing provider, a provider that throws, or an extension that cannot be
loaded or constructed contributes no extension blocks. Generic rendering
continues.

The shell orders blocks by slot, then explicit order, then identifier. Slot
order is `input`, `content`, `output`, `media`. For a tabbed detail view,
extension blocks are merged only into the first, default tab. Later tabs remain
as the built-in renderer declared them.

An unknown `app:*` event resolves through the generic span card and generic
facts detail renderer. Raw Details remains available.

## The live/offline split

With Observatory running and a harness down, trace browsing, generic rendering,
and blob-backed previews continue from the read-only `trace.db`. The concrete
trace, blob, and turn-context routes are served locally and take precedence
over the passthrough.

Agents and prompt lab are unavailable while the harness is down. Extension
enrichment that depends on an application-specific live route is also
unavailable. For example, Canvas transcript-backed thinking, program, and
render blocks require its transcript route; failure must remove that
enrichment without breaking the generic detail view.

With the harness running, catalog access, prompt editing for writable projects,
and application-specific routes are available through
`/registry/kernels/:id/kernel/**`. Observatory passes unmatched routes through
to the harness.

An extension must render something useful from `apiBase` and data available
through the DB-backed routes alone. Data from live-only application routes is
progressive enhancement and must degrade to no enrichment rather than an
error.

## What is deliberately not overridable in v0

The Extensions v0 override surface is detail blocks only. Span cards, the trace
list, overlays, and workspace chrome remain owned by the shared viewer. They
become extension surfaces only after a concrete cross-layer need is
demonstrated.
