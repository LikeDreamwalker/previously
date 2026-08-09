import { DemoPlayground } from "./demo-playground";

/**
 * Thin wrapper — `DemoPlayground` does the heavy lifting. This component
 * remains the target of the ```preview fence in DocsMarkdown.
 */
export function DocPreview({ id }: { id: string }): React.ReactElement {
  return <DemoPlayground id={id} />;
}
