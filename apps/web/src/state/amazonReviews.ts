import type {
  EnvironmentId,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestListStatsInput,
  PullRequestRef,
} from "@t3tools/contracts";
import type { createPullRequestEnvironmentAtoms } from "@t3tools/client-runtime/state/pull-requests";
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import {
  amazonReviewProject,
  amazonReviewReadTarget,
} from "../components/pullRequest/amazonReviewRouting";
import { environmentProjects } from "./projects";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentServerConfigsAtom } from "./server";

type Target<I> = { readonly environmentId: EnvironmentId; readonly input: I };
type Getter = <A>(atom: Atom.Atom<A>) => A;

function readerState(get: Getter) {
  const primary = get(primaryEnvironmentIdAtom);
  const config = primary === null ? undefined : get(environmentServerConfigsAtom).get(primary);
  const connector =
    config?.settings.amazonBetaEnabled === true &&
    config.environment.capabilities.amazonReadConnector === true
      ? primary
      : null;
  const projects = get(environmentProjects.projectsAtom).flatMap((project) => {
    const metadata = amazonReviewProject(project);
    return metadata === null ? [] : [metadata];
  });
  return { connector, projects };
}

function routedQuery<I extends PullRequestRef, A, E>(
  query: (target: Target<I>) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  const family = Atom.family((key: string) => {
    const target = JSON.parse(key) as Target<I>;
    let source = query(target);
    return Atom.writable(
      (get) => {
        const { connector, projects } = readerState(get);
        source = query(amazonReviewReadTarget(target, connector, projects));
        return get(source);
      },
      (context, value: AsyncResult.AsyncResult<A, E>) => context.setSelf(value),
      (refresh) => refresh(source),
    ).pipe(Atom.setIdleTTL(60_000));
  });
  return (target: Target<I>) => family(JSON.stringify(target));
}

function routedCommand<I extends PullRequestRef, A, E>(
  command: AtomCommand<Target<I>, A, E>,
): AtomCommand<Target<I>, A, E> {
  return {
    label: command.label,
    run: (registry, target) => {
      const { connector, projects } = readerState((atom) => registry.get(atom));
      return command.run(registry, amazonReviewReadTarget(target, connector, projects));
    },
  };
}

const empty: PullRequestListResult = {
  viewers: {},
  providers: [],
  entries: [],
  errors: [],
  truncated: false,
  nextCursors: {},
};

/** Reads only. Native writes, GitHub account guards, and execution commands are not rerouted. */
export function withAmazonReviewReader<R, E>(
  base: ReturnType<typeof createPullRequestEnvironmentAtoms<R, E>>,
): ReturnType<typeof createPullRequestEnvironmentAtoms<R, E>> {
  // Instantiate the factory before extracting its return type. A bare ReturnType
  // erases E to unknown, which is unsafe for the input side of writable atoms.
  type StatsState = Atom.Type<ReturnType<typeof base.listStats>>;
  type ListState = Atom.Type<ReturnType<typeof base.list>>;
  const stats = Atom.family((key: string) => {
    const target = JSON.parse(key) as Target<PullRequestListStatsInput>;
    let source: ReturnType<typeof base.listStats> | null = null;
    return Atom.writable(
      (get): StatsState => {
        const { connector, projects } = readerState(get);
        // CRUX listings already carry counts. Do not ask the old execution server to
        // resolve CRUX refs it cannot understand, or mix these IDs into its GitHub cache.
        const refs = target.input.refs.filter(
          (input) =>
            amazonReviewReadTarget(
              { environmentId: target.environmentId, input },
              connector,
              projects,
            ).input.amazonProject === undefined,
        );
        source = refs.length === 0 ? null : base.listStats({ ...target, input: { refs } });
        return source === null ? AsyncResult.success({ stats: [] }) : get(source);
      },
      (context, value: StatsState) => context.setSelf(value),
      (refresh) => {
        if (source !== null) refresh(source);
      },
    );
  });
  const lists = Atom.family((key: string) => {
    const target = JSON.parse(key) as Target<PullRequestListInput>;
    let sources: Array<ReturnType<typeof base.list>> = [];
    return Atom.writable(
      (get): ListState => {
        const { connector, projects } = readerState(get);
        const candidates = projects.filter(
          (project) =>
            project.environmentId === target.environmentId &&
            (target.input.projectId === undefined ||
              target.input.projectId === project.projectId) &&
            (target.input.projectIds === undefined ||
              target.input.projectIds.includes(project.projectId)),
        );
        if (
          connector === null ||
          candidates.length === 0 ||
          (target.input.host !== undefined && target.input.host !== "code.amazon.com")
        ) {
          sources = [base.list(target)];
          return get(sources[0]!);
        }
        const remaining = get(environmentProjects.projectsAtom)
          .filter(
            (project) =>
              project.environmentId === target.environmentId &&
              (target.input.projectId === undefined || target.input.projectId === project.id) &&
              (target.input.projectIds === undefined ||
                target.input.projectIds.includes(project.id)) &&
              !candidates.some((candidate) => candidate.projectId === project.id),
          )
          .map((project) => project.id);
        sources = [
          base.list({
            environmentId: connector,
            input: {
              ...target.input,
              host: "code.amazon.com",
              amazonProjects: candidates,
            },
          }),
          ...(remaining.length > 0 &&
          target.input.host === undefined &&
          get(environmentServerConfigsAtom).get(target.environmentId)?.environment.capabilities
            .pullRequests === true
            ? [base.list({ ...target, input: { ...target.input, projectIds: remaining } })]
            : []),
        ];
        const results = sources.map((source) => get(source));
        const values = results.flatMap((result) => Option.toArray(AsyncResult.value(result)));
        const value = values.reduce<PullRequestListResult>(
          (all, next) => ({
            viewers: { ...all.viewers, ...next.viewers },
            providers: [...all.providers, ...next.providers],
            entries: [...all.entries, ...next.entries],
            errors: [...all.errors, ...next.errors],
            truncated: all.truncated || next.truncated,
            nextCursors: { ...all.nextCursors, ...next.nextCursors },
          }),
          empty,
        );
        const waiting = results.some((result) => result.waiting);
        const failure = results.find((result) => result._tag === "Failure");
        return failure?._tag === "Failure"
          ? AsyncResult.failureWithPrevious(failure.cause, {
              previous: values.length ? Option.some(AsyncResult.success(value)) : Option.none(),
              waiting,
            })
          : AsyncResult.success(value, { waiting });
      },
      (context, value: ListState) => context.setSelf(value),
      (refresh) => sources.forEach((source) => refresh(source)),
    ).pipe(Atom.setIdleTTL(60_000));
  });
  return {
    ...base,
    list: (target: Target<PullRequestListInput>) => lists(JSON.stringify(target)),
    listStats: (target: Target<PullRequestListStatsInput>) => stats(JSON.stringify(target)),
    detail: routedQuery(base.detail),
    activity: routedQuery(base.activity),
    diff: routedQuery(base.diff),
    diffFileContents: routedCommand(base.diffFileContents),
    threadComments: routedCommand(base.threadComments),
  };
}

export { routedQuery as withAmazonReviewQuery };
