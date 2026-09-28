'use client';

/**
 * Staff accounts (ADR 0002).
 *
 * Before this screen existed, creating a cashier meant editing the seed file and
 * running a script — which is the single biggest thing that stopped a renter
 * from using the system on their own.
 *
 * The two guardrails the API enforces are surfaced here rather than only being
 * reported after the fact: the last active administrator cannot be deactivated,
 * and you cannot demote yourself. Both are explained in place, so the refusal
 * reads as a rule rather than as a bug.
 *
 * The two writes that used to happen inline in a table cell — resetting a
 * password, deactivating an account — are dialogs now. A password field in a row
 * has nowhere to state the eight-character rule, and deactivation is not undoable
 * by the person it happens to, so it asks first. (`window.confirm` was the old
 * answer; it blocks the tab, cannot be styled, and is not translated.)
 */
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FieldRow,
  InlineNotice,
  Overlay,
  Pill,
  SelectField,
  Stack,
  TextField,
  type Column,
} from '@/components/ds';
import { apiPatch, apiPost } from '@/lib/client-api';

export interface StaffRow {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  role: 'employee' | 'admin';
  isActive: boolean;
}

const EMPTY_FORM = {
  fullName: '',
  phone: '',
  email: '',
  role: 'employee' as StaffRow['role'],
  password: '',
};

export function StaffManager({
  initialStaff,
  currentUserId,
}: {
  initialStaff: StaffRow[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [staff, setStaff] = useState(initialStaff);
  const [form, setForm] = useState(EMPTY_FORM);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState<StaffRow | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [deactivating, setDeactivating] = useState<StaffRow | null>(null);

  // Server props win on a refresh, the same contract the catalogue screens use.
  useEffect(() => {
    setStaff(initialStaff);
  }, [initialStaff]);

  const activeAdmins = staff.filter((member) => member.role === 'admin' && member.isActive).length;
  const isLastAdmin = (member: StaffRow): boolean =>
    member.role === 'admin' && member.isActive && activeAdmins <= 1;

  function replaceMember(updated: StaffRow): void {
    setStaff((current) => current.map((member) => (member.id === updated.id ? updated : member)));
  }

  async function create(): Promise<void> {
    setNotice(null);
    if (form.fullName.trim() === '' || form.phone.trim() === '') {
      setNotice({ tone: 'danger', text: 'กรอกชื่อและเบอร์โทรก่อนบันทึก' });
      return;
    }
    if (form.password.length < 8) {
      setNotice({ tone: 'danger', text: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' });
      return;
    }

    setCreating(true);
    try {
      const created = await apiPost<StaffRow>('/api/v1/staff', {
        fullName: form.fullName,
        phone: form.phone,
        email: form.email.trim() || null,
        role: form.role,
        password: form.password,
      });
      setStaff((current) =>
        [...current, created].sort((left, right) =>
          left.fullName.localeCompare(right.fullName, 'th'),
        ),
      );
      setForm(EMPTY_FORM);
      setNotice({ tone: 'success', text: `เพิ่มบัญชีของ ${created.fullName} แล้ว` });
      router.refresh();
    } catch (error) {
      setNotice({ tone: 'danger', text: error instanceof Error ? error.message : 'เพิ่มไม่สำเร็จ' });
    } finally {
      setCreating(false);
    }
  }

  async function patch(
    member: StaffRow,
    payload: Record<string, unknown>,
    successText: string,
  ): Promise<void> {
    setNotice(null);
    setBusyId(member.id);
    try {
      const updated = await apiPatch<StaffRow>(`/api/v1/staff/${member.id}`, payload);
      replaceMember(updated);
      setNotice({ tone: 'success', text: successText });
      router.refresh();
    } catch (error) {
      setNotice({ tone: 'danger', text: error instanceof Error ? error.message : 'แก้ไขไม่สำเร็จ' });
    } finally {
      setBusyId(null);
    }
  }

  function toggleActive(member: StaffRow): void {
    if (member.isActive) {
      setDeactivating(member);
      return;
    }
    void patch(member, { isActive: true }, `เปิดการใช้งาน ${member.fullName} แล้ว`);
  }

  const columns: Column<StaffRow>[] = [
    {
      key: 'name',
      header: 'ชื่อ',
      cardLabel: 'ชื่อ',
      render: (member) => (
        <>
          <span className="ln-row">
            <span>{member.fullName}</span>
            {member.id === currentUserId ? <Pill tone="info">คุณ</Pill> : null}
          </span>
          {member.email ? <span className="ln-muted">{member.email}</span> : null}
        </>
      ),
    },
    {
      key: 'phone',
      header: 'เบอร์โทร',
      cardLabel: 'เบอร์โทร',
      render: (member) => <span className="ln-num ln-mono">{member.phone}</span>,
    },
    {
      key: 'role',
      header: 'ตำแหน่ง',
      cardLabel: 'ตำแหน่ง',
      render: (member) => {
        const isSelf = member.id === currentUserId;
        const busy = busyId === member.id;
        return (
          <>
            <SelectField
              id={`role-${member.id}`}
              label={`ตำแหน่งของ ${member.fullName}`}
              hideLabel
              value={member.role}
              disabled={busy || isSelf}
              onChange={(event) =>
                void patch(
                  member,
                  { role: event.target.value },
                  `เปลี่ยนตำแหน่งของ ${member.fullName} แล้ว`,
                )
              }
            >
              <option value="employee">พนักงาน</option>
              <option value="admin">ผู้จัดการ</option>
            </SelectField>
            {isSelf ? <span className="ln-muted">เปลี่ยนของตัวเองไม่ได้</span> : null}
          </>
        );
      },
    },
    {
      key: 'status',
      header: 'สถานะ',
      cardLabel: 'สถานะ',
      render: (member) =>
        member.isActive ? (
          <Pill tone="success">ใช้งานอยู่</Pill>
        ) : (
          <Pill tone="neutral">ปิดใช้งาน</Pill>
        ),
    },
    {
      key: 'actions',
      header: '',
      cardLabel: 'จัดการ',
      align: 'end',
      render: (member) => {
        const isSelf = member.id === currentUserId;
        const lastAdmin = isLastAdmin(member);
        const busy = busyId === member.id;
        return (
          <span className="ln-row">
            <Button
              variant="secondary"
              size="sm"
              icon="key"
              disabled={busy}
              onClick={() => {
                setResetPassword('');
                setResetFor(member);
              }}
            >
              ตั้งรหัสผ่านใหม่
            </Button>
            <Button
              variant={member.isActive ? 'ghost' : 'secondary'}
              size="sm"
              icon={member.isActive ? 'close' : 'check'}
              disabled={busy || (member.isActive && (isSelf || lastAdmin))}
              title={
                isSelf
                  ? 'ปิดการใช้งานบัญชีของตัวเองไม่ได้'
                  : lastAdmin
                    ? 'ต้องมีผู้จัดการที่ใช้งานอยู่อย่างน้อย 1 คน'
                    : undefined
              }
              onClick={() => toggleActive(member)}
            >
              {member.isActive ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <Stack gap="lg">
      {notice ? <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice> : null}

      <Card title="เพิ่มพนักงาน" subtitle="พนักงานใช้เบอร์โทรเข้าสู่ระบบ">
        <Stack gap="md">
          <FieldRow columns={2}>
            <TextField
              id="staff-name"
              label="ชื่อ-นามสกุล"
              autoComplete="name"
              required
              value={form.fullName}
              onChange={(event) => setForm({ ...form, fullName: event.target.value })}
            />
            <TextField
              id="staff-phone"
              label="เบอร์โทร"
              autoComplete="tel"
              inputMode="tel"
              className="ln-num"
              required
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
            />
          </FieldRow>

          <FieldRow columns={2}>
            <SelectField
              id="staff-role"
              label="ตำแหน่ง"
              value={form.role}
              onChange={(event) =>
                setForm({ ...form, role: event.target.value as StaffRow['role'] })
              }
            >
              <option value="employee">พนักงาน (ขายหน้าร้าน)</option>
              <option value="admin">ผู้จัดการ (จัดการได้ทั้งหมด)</option>
            </SelectField>
            <TextField
              id="staff-email"
              label="อีเมล"
              type="email"
              autoComplete="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </FieldRow>

          <TextField
            id="staff-password"
            label="รหัสผ่านชั่วคราว"
            type="password"
            autoComplete="new-password"
            required
            help="อย่างน้อย 8 ตัวอักษร — แจ้งพนักงานแล้วให้เปลี่ยนเองภายหลัง"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
          />

          <div>
            <Button icon="plus" loading={creating} onClick={() => void create()}>
              เพิ่มพนักงาน
            </Button>
          </div>
        </Stack>
      </Card>

      <Card
        title="พนักงานทั้งหมด"
        subtitle={`${staff.length} บัญชี · ผู้จัดการที่ใช้งานอยู่ ${activeAdmins} คน`}
        footer={
          <p className="ln-muted">
            ระบบไม่ให้ปิดการใช้งานผู้จัดการคนสุดท้าย และไม่ให้คุณลดตำแหน่งตัวเอง
            เพื่อไม่ให้ร้านถูกล็อกออกจากหน้าตั้งค่า
          </p>
        }
        flush
      >
        <DataTable
          columns={columns}
          rows={staff}
          getRowKey={(member) => member.id}
          caption="บัญชีพนักงานทั้งหมดในร้าน"
          empty={<EmptyState icon="users" title="ยังไม่มีพนักงาน" description="เพิ่มพนักงานคนแรกจากฟอร์มด้านบน" />}
        />
      </Card>

      <Overlay
        open={resetFor !== null}
        onClose={() => setResetFor(null)}
        title={resetFor ? `ตั้งรหัสผ่านใหม่ให้ ${resetFor.fullName}` : ''}
        description="พนักงานจะใช้รหัสผ่านนี้เข้าสู่ระบบครั้งถัดไป"
        footer={
          <>
            <Button variant="secondary" onClick={() => setResetFor(null)} disabled={busyId !== null}>
              ยกเลิก
            </Button>
            <Button
              icon="key"
              disabled={resetPassword.length < 8 || resetFor === null}
              loading={busyId === resetFor?.id}
              onClick={() => {
                if (!resetFor) {
                  return;
                }
                void patch(
                  resetFor,
                  { password: resetPassword },
                  `ตั้งรหัสผ่านใหม่ให้ ${resetFor.fullName} แล้ว`,
                ).then(() => setResetFor(null));
              }}
            >
              ตั้งรหัสผ่านใหม่
            </Button>
          </>
        }
      >
        <TextField
          id="reset-password"
          label="รหัสผ่านใหม่"
          type="password"
          autoComplete="new-password"
          help="อย่างน้อย 8 ตัวอักษร"
          value={resetPassword}
          onChange={(event) => setResetPassword(event.target.value)}
        />
      </Overlay>

      <ConfirmDialog
        open={deactivating !== null}
        title="ปิดการใช้งานบัญชีนี้?"
        description={
          deactivating
            ? `${deactivating.fullName} จะเข้าสู่ระบบไม่ได้อีก จนกว่าจะเปิดใช้งานกลับ — ประวัติการขายและกะเดิมยังอยู่ครบ`
            : undefined
        }
        confirmLabel="ปิดใช้งาน"
        busy={busyId !== null}
        onConfirm={() => {
          if (!deactivating) {
            return;
          }
          void patch(deactivating, { isActive: false }, `ปิดการใช้งาน ${deactivating.fullName} แล้ว`).then(
            () => setDeactivating(null),
          );
        }}
        onCancel={() => setDeactivating(null)}
      />
    </Stack>
  );
}
