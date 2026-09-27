'use client';

import { ApexChart } from '@/components/hope/ApexChart';

/**
 * Seven-day sales trend.
 *
 * Options are built here, in a client component, rather than in the server
 * component that owns the data: ApexCharts options may contain formatter
 * functions, and functions cannot cross the server/client boundary.
 */
export function SalesChart({
  data,
}: {
  data: { day: string; salesThb: number; orderCount: number }[];
}) {
  const labels = data.map((point) =>
    new Date(`${point.day}T00:00:00`).toLocaleDateString('th-TH', {
      day: 'numeric',
      month: 'short',
    }),
  );

  return (
    <ApexChart
      height={280}
      options={{
        chart: { type: 'area', toolbar: { show: false }, zoom: { enabled: false } },
        series: [
          { name: 'ยอดขาย (บาท)', data: data.map((point) => Math.round(point.salesThb * 100) / 100) },
          { name: 'จำนวนออเดอร์', data: data.map((point) => point.orderCount) },
        ],
        colors: ['#3a57e8', '#21cc6a'],
        xaxis: { categories: labels },
        stroke: { curve: 'smooth', width: 3 },
        fill: {
          type: 'gradient',
          gradient: { shadeIntensity: 0.4, opacityFrom: 0.45, opacityTo: 0.05 },
        },
        dataLabels: { enabled: false },
        grid: { strokeDashArray: 4 },
        legend: { position: 'top', horizontalAlign: 'right' },
        tooltip: { theme: 'light' },
      }}
    />
  );
}
