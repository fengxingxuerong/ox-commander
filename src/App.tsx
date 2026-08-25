import { useEffect } from "react";
import { useApp } from "./store";
import { ProjectsPage } from "./pages/ProjectsPage";
import { BoardPage } from "./pages/BoardPage";

export function App() {
  const page = useApp((s) => s.page);
  const handleEvent = useApp((s) => s.handleEvent);
  const refreshProjects = useApp((s) => s.refreshProjects);

  useEffect(() => {
    void refreshProjects();
    return api_unsubscribe(handleEvent);
  }, [handleEvent, refreshProjects]);

  if (page === "projects") return <ProjectsPage />;
  return <BoardPage />;
}

function api_unsubscribe(handler: (payload: Record<string, unknown>) => void): () => void {
  try {
    return window.oxCommander.onEvent(handler as (payload: unknown) => void);
  } catch {
    // Browser dev mode without Electron preload.
    return () => undefined;
  }
}
