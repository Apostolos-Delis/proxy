import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircle, Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { canAccessPath } from "../access";
import { graphql } from "../gql";
import { gqlFetch } from "../graphql";
import {
  buildPaletteGroups,
  loadRecents,
  MIN_SEARCH_LENGTH,
  palettePages,
  rememberRecent,
  type PaletteAction
} from "./searchData";
import { paletteOptionId, PaletteResults } from "./SearchResults";

const GlobalSearchDocument = graphql(`
  query GlobalSearch($query: String!) {
    search(query: $query) {
      results {
        kind
        id
        title
        subtitle
        status
        snippet
        occurredAt
      }
    }
  }
`);

export function SearchPalette({ isAdmin, onClose }: { isAdmin: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [requestedIndex, setRequestedIndex] = useState(0);
  const [recents] = useState(loadRecents);

  const query = input.trim();
  const deferredQuery = useDeferredValue(query);
  const canSearch = deferredQuery.length >= MIN_SEARCH_LENGTH;
  const { data: searchData, isFetching: searchIsFetching, error: searchError } = useQuery({
    queryKey: ["global-search", deferredQuery],
    queryFn: async () => (await gqlFetch(GlobalSearchDocument, { query: deferredQuery })).search,
    enabled: isAdmin && canSearch,
    placeholderData: keepPreviousData,
    staleTime: 15_000
  });

  const hits = canSearch && searchData ? searchData.results : [];
  const groups = buildPaletteGroups({ query, hits, recents, isAdmin });
  const actions = groups.flatMap((group) => group.actions);
  const activeIndex = actions.length > 0 ? Math.min(requestedIndex, actions.length - 1) : -1;
  const searching = query.length >= MIN_SEARCH_LENGTH;
  const pending = searching && (query !== deferredQuery || searchIsFetching);
  const settled = searching && !pending && !searchError;
  const errorMessage = searchError instanceof Error ? searchError.message : null;

  const openAction = (action: PaletteAction) => {
    if (!isAdmin && action.kind !== "page") return;
    rememberRecent(action);
    onClose();
    if (action.kind === "session") {
      void navigate({ to: "/sessions/$sessionId", params: { sessionId: action.id } });
      return;
    }
    if (action.kind === "log") {
      void navigate({ to: "/logs/$artifactId", params: { artifactId: action.id } });
      return;
    }
    if (action.kind === "routing_config") {
      void navigate({ to: "/routing/$configId", params: { configId: action.id } });
      return;
    }
    if (action.kind === "user") {
      void navigate({ to: "/users" });
      return;
    }
    if (action.kind === "api_key") {
      void navigate({ to: "/api-keys" });
      return;
    }
    const page = palettePages.find((item) => item.path === action.id);
    if (page && canAccessPath(page.path, isAdmin)) void navigate({ to: page.path });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (actions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setRequestedIndex((current) => Math.min(current + 1, actions.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setRequestedIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      if (event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      const action = actions[activeIndex];
      if (action) openAction(action);
    }
  };

  return (
    <>
      <div className="palette-scrim" onClick={onClose} />
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Global search"
        onKeyDown={handleKeyDown}
      >
        <div className="palette-input">
          {pending ? <LoaderCircle className="palette-spin" /> : <Search />}
          <input
            autoFocus
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={activeIndex >= 0 ? paletteOptionId(activeIndex) : undefined}
            aria-label="Search the console"
            placeholder={isAdmin ? "Search sessions, prompts, users, configs..." : "Search pages..."}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setRequestedIndex(0);
            }}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="palette-body" id="palette-results" role="listbox" aria-label="Search results">
          <PaletteResults
            groups={groups}
            query={query}
            activeIndex={activeIndex}
            showSkeleton={pending && actions.length === 0}
            emptyLabel={settled && actions.length === 0 ? deferredQuery : null}
            error={errorMessage}
            onOpen={openAction}
            onHover={setRequestedIndex}
          />
        </div>
        <footer className="palette-foot">
          <span className="palette-hint"><span className="kbd">↑</span><span className="kbd">↓</span>Navigate</span>
          <span className="palette-hint"><span className="kbd">↵</span>Open</span>
          <span className="palette-hint"><span className="kbd">esc</span>Close</span>
          {settled ? (
            <span className="palette-count">
              {actions.length} {actions.length === 1 ? "result" : "results"}
            </span>
          ) : null}
        </footer>
      </div>
    </>
  );
}
