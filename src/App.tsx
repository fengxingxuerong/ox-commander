import { useEffect } from "react";
import { useApp } from "./store";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ProjectsPage } from "./pages/ProjectsPage";
import { BoardPage } from "./pages/BoardPage";
import { PrdReviewPage } from "./pages/PrdReviewPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  const page = useApp((s) => s.page);
  const handleEvent = useApp((s) => s.handleEvent);
  const refreshProjects = useApp((s) => s.refreshProjects);

  useEffect(() => {
    void refreshProjects();
    return api_unsubscribe(handleEvent);
  }, [handleEvent, refreshProjects]);

  return (
    <ErrorBoundary>
      <CurrentPage page={page} />
    </ErrorBoundary>
  );
}

function CurrentPage({ page }: { page: ReturnType<typeof useApp.getState>["page"] }) {
  switch (page) {
    case "board":
      return <BoardPage />;
    case "prd-review":
      return <PrdReviewPage />;
    case "settings":
      return <SettingsPage />;
    default:
      return <ProjectsPage />;
  }
}

function api_unsubscribe(handler: (payload: Record<string, unknown>) => void): () => void {
  try {
    return window.oxCommander.onEvent(handler as (payload: unknown) => void);
  } catch {
    // Browser dev mode without Electron preload.
    return () => undefined;
  }
}
