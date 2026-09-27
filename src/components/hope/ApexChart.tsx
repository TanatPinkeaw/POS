'use client';

import { useEffect, useRef } from 'react';

/**
 * ApexCharts wrapper.
 *
 * The chart library is imported dynamically so it stays out of the first-load
 * bundle — a dashboard chart is not worth blocking the till's paint on. The
 * vendored Hope UI chart scripts are only demo config, so the library itself
 * comes from npm.
 *
 * Options are compared by serialised value, otherwise an inline options object
 * would tear down and rebuild the chart on every parent render.
 */
export function ApexChart({
  options,
  height = 280,
  className = '',
}: {
  options: Record<string, unknown>;
  height?: number;
  className?: string;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    let destroyed = false;
    let chart: { destroy: () => void } | null = null;

    void import('apexcharts').then(({ default: ApexCharts }) => {
      if (destroyed || !container.current) {
        return;
      }

      const instance = new ApexCharts(container.current, {
        ...(JSON.parse(optionsKey) as Record<string, unknown>),
        chart: {
          ...((JSON.parse(optionsKey) as { chart?: Record<string, unknown> }).chart ?? {}),
          height,
          fontFamily: 'Inter, "Noto Sans Thai", sans-serif',
        },
      });
      void instance.render();
      chart = instance;
    });

    return () => {
      destroyed = true;
      chart?.destroy();
    };
  }, [optionsKey, height]);

  return <div ref={container} className={className} />;
}
