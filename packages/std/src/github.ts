import * as Github from "@distilled.cloud/github";
/**
 * GitHub Resources on `@distilled.cloud/github`.
 *
 * `PullRequestComment` keeps one comment per `(scope, FQN)` on a pull request:
 * rerunning a workflow for the same scope edits the comment instead of posting
 * another. Each body ends with a hidden marker,
 * `<!-- effectory:<scope>:<fqn> -->`, so `read` can find a comment an
 * interrupted run posted before its state row recorded the comment id.
 *
 * The live provider needs an `HttpClient` and `Github.Credentials`; `live`
 * provides both from `fetch` and `GITHUB_TOKEN`/`GH_TOKEN`. In fake mode the
 * same provider code talks to an in-memory GitHub (`memoryApi`), so fakes
 * exercise the real request paths without the network.
 */
import { Provider, Resource } from "@effectory/core";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const nonEmpty = Schema.String.check(Schema.isMinLength(1));

export const PullRequestCommentProps = Schema.Struct({
  body: Schema.String,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  owner: nonEmpty,
  repo: nonEmpty,
});
type Props = typeof PullRequestCommentProps.Type;

export const PullRequestCommentAttributes = Schema.Struct({
  commentId: Schema.Int,
  /** The comment's `html_url`. */
  url: Schema.String,
});
type Attributes = typeof PullRequestCommentAttributes.Type;

export const PullRequestComment = Resource.make("GitHub.PullRequestComment", {
  attributes: PullRequestCommentAttributes,
  description:
    "A pull request comment owned by this collection, edited in place on reruns",
  props: PullRequestCommentProps,
});

/** What GitHub operations need: an HTTP client and credentials. */
export type Requirements = Github.GithubOpContext;

/** `fetch` plus credentials from `GITHUB_TOKEN` (or `GH_TOKEN`) and `GITHUB_API_URL`. */
export const live: Layer.Layer<Requirements> = Layer.mergeAll(
  FetchHttpClient.layer,
  Github.CredentialsFromEnv
);

/** The hidden marker that identifies the comment for `(scope, fqn)`. */
export const marker = (scope: string, fqn: string) =>
  `<!-- effectory:${`${scope}:${fqn}`.replaceAll("--", "-⁠-")} -->`;

const withMarker = (body: string, scope: string, fqn: string) =>
  `${body}\n\n${marker(scope, fqn)}`;

const ownerRepo = (props: Props) => ({
  owner: props.owner,
  repo: props.repo,
});

const toAttributes = (comment: {
  readonly id: number;
  readonly html_url: string;
}): Attributes => ({
  commentId: comment.id,
  url: comment.html_url,
});

const perPage = 100;

/**
 * GitHub's 404. Operations that do not declare one (`deleteComment`,
 * `updateComment`) still surface it as a `NotFound`-tagged error.
 */
const isNotFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "NotFound";

/** Page through the pull request's comments for one carrying `mark`. */
const findByMarker = (props: Props, mark: string) =>
  Effect.gen(function* findComment() {
    for (let page = 1; ; page += 1) {
      const comments = yield* Github.issues.listComments({
        ...ownerRepo(props),
        issue_number: props.number,
        page,
        per_page: perPage,
      });
      const found = comments.find((comment) => comment.body?.includes(mark));
      if (found !== undefined) {
        return toAttributes(found);
      }
      if (comments.length < perPage) {
        return;
      }
    }
  }).pipe(Effect.catchTag("NotFound", () => Provider.absent));

const create = (props: Props, scope: string, fqn: string) =>
  Github.issues
    .createComment({
      ...ownerRepo(props),
      body: withMarker(props.body, scope, fqn),
      issue_number: props.number,
    })
    .pipe(Effect.map(toAttributes));

/** The provider service over distilled; requires `Requirements`. */
export const liveService: Provider.ProviderService<
  Props,
  Attributes,
  Requirements
> = {
  delete: ({ olds, output }) =>
    Github.issues
      .deleteComment({ ...ownerRepo(olds), comment_id: output.commentId })
      .pipe(
        Effect.asVoid,
        Effect.catchIf(isNotFound, () => Effect.void)
      ),
  diff: ({ news, olds }) => {
    if (
      olds.owner !== news.owner ||
      olds.repo !== news.repo ||
      olds.number !== news.number
    ) {
      return Effect.succeed({ action: "replace" });
    }
    return Effect.succeed({
      action: olds.body === news.body ? "noop" : "update",
    });
  },
  read: ({ fqn, olds, output, scope }) =>
    output === undefined
      ? findByMarker(olds, marker(scope, fqn))
      : Github.issues
          .getComment({ ...ownerRepo(olds), comment_id: output.commentId })
          .pipe(
            Effect.map(toAttributes),
            Effect.catchTag("NotFound", () => Provider.absent)
          ),
  reconcile: ({ fqn, news, output, scope }) =>
    output === undefined
      ? create(news, scope, fqn)
      : Github.issues
          .updateComment({
            ...ownerRepo(news),
            body: withMarker(news.body, scope, fqn),
            comment_id: output.commentId,
          })
          .pipe(
            Effect.map(toAttributes),
            // Deleted out of band since `read`: post it again.
            Effect.catchIf(isNotFound, () => create(news, scope, fqn))
          ),
  stables: ["commentId"],
};

/** A comment held by the in-memory GitHub. */
export interface StoredComment {
  readonly id: number;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  body: string;
}

/** An in-memory GitHub serving the issue-comment endpoints. */
export interface MemoryApi {
  /** `HttpClient` and `Credentials` that route GitHub calls to this store. */
  readonly context: Context.Context<Requirements>;
  readonly layer: Layer.Layer<Requirements>;
  /** Live comments, oldest first. */
  readonly comments: () => readonly StoredComment[];
  /** Every request served, as `METHOD /path`. */
  readonly requests: readonly string[];
  /** Add a comment out of band (e.g. someone else's). */
  readonly seed: (comment: Omit<StoredComment, "id">) => StoredComment;
}

const memoryBaseUrl = "https://api.github.memory";

const bodyText = (request: HttpClientRequest.HttpClientRequest) => {
  const { body } = request;
  if (body._tag === "Uint8Array") {
    return new TextDecoder().decode(body.body);
  }
  if (body._tag === "Raw" && typeof body.body === "string") {
    return body.body;
  }
  return "";
};

const commentsPath =
  /^\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/issues\/(?<number>\d+)\/comments$/u;
const commentPath =
  /^\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/issues\/comments\/(?<id>\d+)$/u;

const json = (status: number, value?: unknown) =>
  new Response(value === undefined ? null : JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });

const notFound = () =>
  json(404, {
    documentation_url: "https://docs.github.com/rest",
    message: "Not Found",
  });

/** Serve the issue-comment endpoints GitHub.PullRequestComment uses from memory. */
export const memoryApi = (): MemoryApi => {
  const store = new Map<number, StoredComment>();
  const requests: string[] = [];
  let next = 1000;

  const render = (comment: StoredComment) => ({
    body: comment.body,
    created_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/${comment.owner}/${comment.repo}/pull/${comment.number}#issuecomment-${comment.id}`,
    id: comment.id,
    issue_url: `${memoryBaseUrl}/repos/${comment.owner}/${comment.repo}/issues/${comment.number}`,
    node_id: `IC_${comment.id}`,
    updated_at: "2026-01-01T00:00:00Z",
    url: `${memoryBaseUrl}/repos/${comment.owner}/${comment.repo}/issues/comments/${comment.id}`,
    user: null,
  });
  const seed = (comment: Omit<StoredComment, "id">) => {
    next += 1;
    const stored = { ...comment, id: next };
    store.set(stored.id, stored);
    return stored;
  };

  const route = (method: string, url: URL, text: string): Response => {
    const many = commentsPath.exec(url.pathname)?.groups;
    if (many !== undefined) {
      const { owner = "", repo = "" } = many;
      const number = Number(many.number);
      if (method === "POST") {
        const { body } = JSON.parse(text) as { readonly body: string };
        return json(201, render(seed({ body, number, owner, repo })));
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      const size = Number(url.searchParams.get("per_page") ?? "30");
      const matching = [...store.values()].filter(
        (comment) =>
          comment.owner === owner &&
          comment.repo === repo &&
          comment.number === number
      );
      return json(
        200,
        matching.slice((page - 1) * size, page * size).map(render)
      );
    }
    const one = commentPath.exec(url.pathname)?.groups;
    const comment = one === undefined ? undefined : store.get(Number(one.id));
    if (
      one === undefined ||
      comment === undefined ||
      comment.owner !== one.owner ||
      comment.repo !== one.repo
    ) {
      return notFound();
    }
    if (method === "PATCH") {
      comment.body = (JSON.parse(text) as { readonly body: string }).body;
      return json(200, render(comment));
    }
    if (method === "DELETE") {
      store.delete(comment.id);
      return new Response(null, { status: 204 });
    }
    return json(200, render(comment));
  };

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push(`${request.method} ${url.pathname}`);
      return HttpClientResponse.fromWeb(
        request,
        route(request.method, url, bodyText(request))
      );
    })
  );
  const context = Context.make(HttpClient.HttpClient, client).pipe(
    Context.add(
      Github.Credentials,
      Effect.succeed({
        apiBaseUrl: memoryBaseUrl,
        token: Redacted.make("memory"),
        userAgent: "effectory-memory",
      })
    )
  );
  return {
    comments: () => [...store.values()],
    context,
    layer: Layer.succeedContext(context),
    requests,
    seed,
  };
};

/** `service` with its requirements provided from `context`. */
const provideAll = <P, A, R>(
  service: Provider.ProviderService<P, A, R>,
  context: Context.Context<R>
): Provider.ProviderService<P, A> => {
  const provide = <X, E>(effect: Effect.Effect<X, E, R>) =>
    Effect.provideContext(effect, context);
  const { checks, diff, stables } = service;
  return {
    delete: (input) => provide(service.delete(input)),
    read: (input) => provide(service.read(input)),
    reconcile: (input) => provide(service.reconcile(input)),
    ...(checks === undefined
      ? {}
      : { checks: (input) => provide(checks(input)) }),
    ...(diff === undefined ? {} : { diff: (input) => provide(diff(input)) }),
    ...(stables === undefined ? {} : { stables }),
  };
};

/**
 * The PullRequestComment provider: distilled in live mode (requires
 * `Requirements`, e.g. `GitHub.live`), and the same code against `fake`
 * (default: a fresh `memoryApi()`) in fake mode.
 */
export const makePullRequestCommentProvider = (
  options: { readonly fake?: MemoryApi } = {}
) =>
  Provider.dual(PullRequestComment, {
    fake: Effect.sync(() =>
      provideAll(liveService, (options.fake ?? memoryApi()).context)
    ),
    live: Effect.succeed(liveService),
  });

export const PullRequestCommentProvider = makePullRequestCommentProvider();
