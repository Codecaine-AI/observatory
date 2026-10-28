import { useEffect, useState } from "react";
import type { DetailBlockProvider } from "@codecaine-ai/agent-kernel-viewer-ui";

import { viewerApiPrefix, type RegistryProject } from "./api";

export interface ObservatoryViewerExtension {
  appId: string;
  createDetailBlockProvider(context: {
    apiBase: string;
  }): DetailBlockProvider;
}

type ExtensionModule = {
  default?: unknown;
  observatoryViewerExtension?: unknown;
  viewerExtension?: unknown;
};

const bundledExtensionLoaders: Readonly<
  Record<string, () => Promise<ExtensionModule>>
> = {
  "@codecaine-ai/canvas-agent/viewer-extension": () =>
    import("@codecaine-ai/canvas-agent/viewer-extension"),
};

interface CachedExtension {
  specifier: string;
  promise: Promise<ObservatoryViewerExtension | null>;
}

const extensionCache = new Map<string, CachedExtension>();

/**
 * Resolve one project's optional viewer extension. Every import, module-shape,
 * app-id, and provider-construction failure becomes the generic null provider.
 */
export function loadProjectExtension(
  project: RegistryProject,
): Promise<ObservatoryViewerExtension | null> {
  const specifier = project.extensionPackage;
  if (!specifier) return Promise.resolve(null);

  const cached = extensionCache.get(project.id);
  if (cached?.specifier === specifier) return cached.promise;

  const promise = importExtension(project.id, specifier);
  extensionCache.set(project.id, { specifier, promise });
  return promise;
}

export function useProjectDetailBlockProvider(
  project: RegistryProject,
): DetailBlockProvider | undefined {
  const [provider, setProvider] = useState<DetailBlockProvider | undefined>();

  useEffect(() => {
    let cancelled = false;
    setProvider(undefined);

    void loadProjectExtension(project).then((extension) => {
      if (cancelled || !extension) return;
      try {
        const nextProvider = extension.createDetailBlockProvider({
          apiBase: viewerApiPrefix(project.id),
        });
        if (typeof nextProvider !== "function") {
          throw new Error("createDetailBlockProvider did not return a function");
        }
        setProvider(() => nextProvider);
      } catch (cause) {
        warnExtensionFailure(project.id, project.extensionPackage, cause);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [project.id, project.extensionPackage]);

  return provider;
}

async function importExtension(
  projectId: string,
  specifier: string,
): Promise<ObservatoryViewerExtension | null> {
  try {
    // Known extensions use literal imports so Vite includes linked packages in
    // the UI build. Unknown registry entries stay runtime-driven and retain the
    // same generic-rendering fallback when the browser cannot resolve them.
    const loader = bundledExtensionLoaders[specifier];
    const imported = loader
      ? await loader()
      : ((await import(/* @vite-ignore */ specifier)) as ExtensionModule);
    const extension = readExtension(imported);
    if (!extension) throw new Error("module did not export a viewer extension");
    if (extension.appId !== projectId) {
      throw new Error(
        `extension appId "${extension.appId}" does not match project "${projectId}"`,
      );
    }
    return extension;
  } catch (cause) {
    warnExtensionFailure(projectId, specifier, cause);
    return null;
  }
}

function readExtension(module: ExtensionModule): ObservatoryViewerExtension | null {
  const candidates = [
    module.observatoryViewerExtension,
    module.viewerExtension,
    module.default,
    module,
  ];
  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      "appId" in candidate &&
      typeof candidate.appId === "string" &&
      "createDetailBlockProvider" in candidate &&
      typeof candidate.createDetailBlockProvider === "function"
    ) {
      return candidate as ObservatoryViewerExtension;
    }
  }
  return null;
}

function warnExtensionFailure(
  projectId: string,
  specifier: string | null,
  cause: unknown,
): void {
  console.warn(
    `[observatory] Viewer extension unavailable for "${projectId}"${
      specifier ? ` (${specifier})` : ""
    }; using generic trace rendering.`,
    cause,
  );
}
