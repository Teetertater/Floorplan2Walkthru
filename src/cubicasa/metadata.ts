export interface PlanMeta {
  id: string;
  name: string;
  scaleMetersPerUnit: number;
  startRoom?: string;
  outerPerimeter: [number, number][];
}

export interface PlanBundle {
  meta: PlanMeta;
  svgText: string;
}

export interface PlanManifestEntry {
  id: string;
  name: string;
}

export async function loadManifest(): Promise<PlanManifestEntry[]> {
  const res = await fetch('/plans/manifest.json');
  return res.json();
}

export async function loadPlanBundle(planId: string): Promise<PlanBundle> {
  const [configRes, svgRes] = await Promise.all([
    fetch(`/plans/${planId}/config.json`),
    fetch(`/plans/${planId}/model.svg`),
  ]);

  const config = await configRes.json();
  const svgText = await svgRes.text();

  return {
    meta: {
      id: planId,
      name: config.name,
      scaleMetersPerUnit: config.scaleMetersPerUnit,
      startRoom: config.startRoom,
      outerPerimeter: config.outerPerimeter,
    },
    svgText,
  };
}
