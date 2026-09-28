'use client';

import { useState } from 'react';

import { Button, Card, ConfirmDialog, InlineNotice, Pill, Stack } from '@/components/ds';
import { apiFetch } from '@/lib/client-api';
import { bangkokDayString, bangkokTimeString } from '@/lib/bangkok-time';
import type { DisplayDeviceView } from '@/lib/display-view';

import styles from './DisplayDevicesPanel.module.css';

interface PairingCode {
  id: string;
  code: string;
  expiresAt: string;
}

/**
 * Pairing a customer screen with this till.
 *
 * The code is shown at a size a person can read from across the counter, because
 * whoever is installing the screen is holding a tablet in one hand and typing into
 * it with the other. It expires in minutes, so the panel says how long is left
 * rather than leaving somebody to discover it.
 *
 * The list exists to answer the question an owner actually has — "which screens
 * are attached to my till, and are they still alive" — so it shows a last-seen
 * time and a revoke button, and nothing else.
 */
export function DisplayDevicesPanel({
  initialDevices,
}: {
  initialDevices: DisplayDeviceView[];
}) {
  const [devices, setDevices] = useState(initialDevices);
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<DisplayDeviceView | null>(null);

  const refresh = async (): Promise<void> => {
    const payload = await apiFetch<{ devices: DisplayDeviceView[] }>('/api/v1/display/devices');
    setDevices(payload.devices);
  };

  const startPairing = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const code = await apiFetch<PairingCode>('/api/v1/display/devices', {
        method: 'POST',
        body: JSON.stringify({ label: label.trim() || null }),
      });
      setPairing(code);
      setLabel('');
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ขอรหัสจับคู่ไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (): Promise<void> => {
    if (!revoking) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/display/devices/${revoking.id}`, { method: 'DELETE' });
      setNotice(`ยกเลิกจอ "${revoking.label}" แล้ว — จอจะหลุดเมื่อเชื่อมต่อใหม่ครั้งถัดไป`);
      setRevoking(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ยกเลิกจอไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="จอลูกค้า"
      subtitle="เปิด /display บนแท็บเล็ตหรือทีวีของร้าน แล้วใส่รหัสด้านล่าง — จอจะแสดงรายการที่กำลังคิดเงินและ QR พร้อมเพย์ให้ลูกค้าสแกน"
    >
      <Stack gap="md">
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
        {notice ? <InlineNotice tone="success">{notice}</InlineNotice> : null}

        {pairing ? (
          <div className={styles.codeBox}>
            <p className={styles.codeKicker}>รหัสจับคู่</p>
            <p className={styles.code}>{pairing.code}</p>
            <p className={styles.codeHint}>
              หมดอายุ {bangkokTimeString(new Date(pairing.expiresAt))} — ใส่ได้ครั้งเดียว
            </p>
            <Button variant="secondary" size="sm" onClick={() => setPairing(null)}>
              ปิดรหัส
            </Button>
          </div>
        ) : (
          <div className={styles.pairRow}>
            <input
              className={styles.input}
              placeholder="ชื่อจอ เช่น จอหน้าเคาน์เตอร์"
              value={label}
              maxLength={60}
              onChange={(event) => setLabel(event.target.value)}
            />
            <Button variant="primary" icon="monitor" loading={busy} onClick={() => void startPairing()}>
              เพิ่มจอ
            </Button>
          </div>
        )}

        {devices.length === 0 ? (
          <p className={styles.empty}>ยังไม่มีจอที่ผูกไว้</p>
        ) : (
          <ul className={styles.list}>
            {devices.map((device) => {
              const revoked = device.revokedAt !== null;
              const unpaired = device.lastSeenAt === null && !revoked;
              return (
                <li key={device.id} className={styles.item}>
                  <div>
                    <p className={styles.itemLabel}>{device.label}</p>
                    <p className={styles.itemMeta}>
                      {revoked
                        ? `ยกเลิกเมื่อ ${bangkokDayString(new Date(device.revokedAt as string))}`
                        : unpaired
                          ? 'รอจอใส่รหัสจับคู่'
                          : `เชื่อมต่อล่าสุด ${bangkokDayString(new Date(device.lastSeenAt as string))} ${bangkokTimeString(new Date(device.lastSeenAt as string))}`}
                      {device.pairedByName ? ` · เพิ่มโดย ${device.pairedByName}` : ''}
                    </p>
                  </div>
                  {revoked ? (
                    <Pill tone="neutral">ยกเลิกแล้ว</Pill>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => setRevoking(device)}>
                      ยกเลิกจอ
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Stack>

      <ConfirmDialog
        open={revoking !== null}
        title="ยกเลิกจอนี้"
        description={`จอ "${revoking?.label ?? ''}" จะหยุดรับข้อมูลทันทีที่เชื่อมต่อใหม่ และต้องจับคู่ใหม่ถ้าจะใช้ต่อ`}
        confirmLabel="ยกเลิกจอ"
        busy={busy}
        onConfirm={() => void revoke()}
        onCancel={() => setRevoking(null)}
      />
    </Card>
  );
}
