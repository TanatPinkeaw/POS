'use client';

/**
 * Customer accounts (ADR 0010).
 *
 * Until this screen existed, the only way a customer could exist was a developer
 * running SQL — which meant the pre-order feature, the member area and SRS §5
 * loyalty were all unreachable on a freshly installed shop. This is the counter
 * half of that: a manager opens it with a customer in front of them.
 *
 * The password here is a **temporary** one handed over at the counter, which is
 * the only shape that works for a shop with no email address on file and no
 * customer app to send an invitation from. Everything about the account that
 * follows is the customer's own to change once they are signed in.
 *
 * Points are shown and never edited. A balance is the sum of a ledger, and a
 * screen that could type a number into it would be a screen that can invent a
 * liability — the adjustment belongs in the loyalty module, with a reason, not in
 * a text field here.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

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
  SearchField,
  Stack,
  TextField,
  type Column,
} from '@/components/ds';
import { apiPatch, apiPost } from '@/lib/client-api';

export interface MemberRow {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  isActive: boolean;
  pointsBalance: number;
  orderCount: number;
  /** Bangkok calendar day, already formatted on the server. */
  joinedOn: string;
}

const EMPTY_FORM = {
  fullName: '',
  phone: '',
  email: '',
  password: '',
};

export function MembersManager({ initialMembers }: { initialMembers: MemberRow[] }) {
  const router = useRouter();
  const [members, setMembers] = useState(initialMembers);
  const [form, setForm] = useState(EMPTY_FORM);
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MemberRow | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [resetFor, setResetFor] = useState<MemberRow | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [closing, setClosing] = useState<MemberRow | null>(null);

  // Server props win on a refresh, the same contract the staff screen uses.
  useEffect(() => {
    setMembers(initialMembers);
  }, [initialMembers]);

  /*
   * Filtered in the browser over the whole list rather than by a query. The list
   * is a shop's customers — hundreds, not millions — and a round trip per
   * keystroke would be the slower way to find somebody standing at the counter.
   */
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') {
      return members;
    }
    return members.filter((member) =>
      [member.fullName, member.phone, member.email ?? ''].some((field) =>
        field.toLowerCase().includes(needle),
      ),
    );
  }, [members, filter]);

  const activeCount = members.filter((member) => member.isActive).length;

  function replaceMember(updated: MemberRow): void {
    setMembers((current) =>
      current
        .map((member) => (member.id === updated.id ? updated : member))
        .sort((left, right) => left.fullName.localeCompare(right.fullName, 'th')),
    );
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
      const created = await apiPost<MemberRow>('/api/v1/members', {
        fullName: form.fullName,
        phone: form.phone,
        email: form.email.trim() || null,
        password: form.password,
      });
      setMembers((current) =>
        [...current, created].sort((left, right) =>
          left.fullName.localeCompare(right.fullName, 'th'),
        ),
      );
      setForm(EMPTY_FORM);
      setNotice({
        tone: 'success',
        text: `เพิ่มบัญชีของ ${created.fullName} แล้ว — แจ้งรหัสผ่านชั่วคราวให้ลูกค้าตั้งแต่ตอนนี้`,
      });
      router.refresh();
    } catch (error) {
      setNotice({ tone: 'danger', text: error instanceof Error ? error.message : 'เพิ่มไม่สำเร็จ' });
    } finally {
      setCreating(false);
    }
  }

  async function patch(
    member: MemberRow,
    payload: Record<string, unknown>,
    successText: string,
  ): Promise<void> {
    setNotice(null);
    setBusyId(member.id);
    try {
      const updated = await apiPatch<MemberRow>(`/api/v1/members/${member.id}`, payload);
      replaceMember(updated);
      setNotice({ tone: 'success', text: successText });
      router.refresh();
    } catch (error) {
      setNotice({ tone: 'danger', text: error instanceof Error ? error.message : 'แก้ไขไม่สำเร็จ' });
    } finally {
      setBusyId(null);
    }
  }

  const columns: Column<MemberRow>[] = [
    {
      key: 'name',
      header: 'ชื่อ',
      cardLabel: 'ชื่อ',
      render: (member) => (
        <>
          <span>{member.fullName}</span>
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
      key: 'points',
      header: 'คะแนนสะสม',
      cardLabel: 'คะแนนสะสม',
      align: 'end',
      render: (member) => (
        <>
          <span className="ln-num ln-mono">{member.pointsBalance}</span>
          <span className="ln-muted">{member.orderCount} ออเดอร์</span>
        </>
      ),
    },
    {
      key: 'joined',
      header: 'สมัครเมื่อ',
      cardLabel: 'สมัครเมื่อ',
      render: (member) => <span className="ln-num ln-muted">{member.joinedOn}</span>,
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
              variant="secondary"
              size="sm"
              icon="edit"
              disabled={busy}
              onClick={() => {
                setEditForm({
                  fullName: member.fullName,
                  phone: member.phone,
                  email: member.email ?? '',
                  password: '',
                });
                setEditing(member);
              }}
            >
              แก้ข้อมูล
            </Button>
            <Button
              variant={member.isActive ? 'ghost' : 'secondary'}
              size="sm"
              icon={member.isActive ? 'close' : 'check'}
              disabled={busy}
              onClick={() => {
                if (member.isActive) {
                  setClosing(member);
                  return;
                }
                void patch(member, { isActive: true }, `เปิดการใช้งาน ${member.fullName} แล้ว`);
              }}
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

      <Card
        title="สมัครสมาชิกใหม่"
        subtitle="ลูกค้าใช้เบอร์โทรนี้เข้าสู่ระบบ และใช้เบอร์เดิมให้พนักงานค้นหาที่หน้าร้านได้"
      >
        <Stack gap="md">
          <FieldRow columns={2}>
            <TextField
              id="member-name"
              label="ชื่อ-นามสกุล"
              autoComplete="name"
              required
              value={form.fullName}
              onChange={(event) => setForm({ ...form, fullName: event.target.value })}
            />
            <TextField
              id="member-phone"
              label="เบอร์โทร"
              autoComplete="tel"
              inputMode="tel"
              className="ln-num"
              required
              help="ใช้เป็นชื่อผู้ใช้ในการเข้าสู่ระบบ — ใส่ขีดหรือไม่ใส่ก็ได้"
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
            />
          </FieldRow>

          <FieldRow columns={2}>
            <TextField
              id="member-email"
              label="อีเมล"
              type="email"
              autoComplete="email"
              help="ไม่บังคับ — ใช้เข้าสู่ระบบแทนเบอร์โทรได้"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
            <TextField
              id="member-password"
              label="รหัสผ่านชั่วคราว"
              type="password"
              autoComplete="new-password"
              required
              help="อย่างน้อย 8 ตัวอักษร — บอกรหัสนี้กับลูกค้าตอนสมัคร แล้วให้เขาเปลี่ยนเองภายหลัง"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
            />
          </FieldRow>

          <div>
            <Button icon="plus" loading={creating} onClick={() => void create()}>
              สมัครสมาชิก
            </Button>
          </div>
        </Stack>
      </Card>

      <Card
        title="ลูกค้าทั้งหมด"
        subtitle={
          filter.trim() === ''
            ? `${members.length} บัญชี · ใช้งานอยู่ ${activeCount} คน`
            : `แสดง ${shown.length} จาก ${members.length} บัญชี`
        }
        toolbar={
          <SearchField
            id="member-search"
            label="ค้นหาลูกค้า"
            placeholder="ค้นหาชื่อ เบอร์โทร หรืออีเมล"
            value={filter}
            onChange={setFilter}
          />
        }
        footer={
          <p className="ln-muted">
            คะแนนสะสมแก้ที่นี่ไม่ได้ เพราะเป็นยอดที่คำนวณจากประวัติการซื้อ — ถ้าต้องปรับจริง
            ให้แก้ที่รายการคะแนนพร้อมระบุเหตุผล
          </p>
        }
        flush
      >
        <DataTable
          columns={columns}
          rows={shown}
          getRowKey={(member) => member.id}
          caption="บัญชีลูกค้าทั้งหมดของร้าน"
          empty={
            filter.trim() === '' ? (
              <EmptyState
                icon="user"
                title="ยังไม่มีลูกค้า"
                description="สมัครสมาชิกคนแรกจากฟอร์มด้านบน — ลูกค้าต้องมีบัญชีก่อนจึงจะสั่งพรีออเดอร์ได้"
              />
            ) : (
              <EmptyState
                icon="search"
                title="ไม่พบลูกค้าที่ตรงกับคำค้น"
                description={`ไม่มีชื่อ เบอร์โทร หรืออีเมลที่ตรงกับ “${filter.trim()}”`}
              />
            )
          }
        />
      </Card>

      <Overlay
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `แก้ข้อมูลของ ${editing.fullName}` : ''}
        description="แก้เฉพาะข้อมูลติดต่อของบัญชี — รหัสผ่านแยกไปที่ปุ่มตั้งรหัสผ่านใหม่"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={busyId !== null}>
              ยกเลิก
            </Button>
            <Button
              icon="check"
              disabled={editForm.fullName.trim() === '' || editForm.phone.trim() === ''}
              loading={busyId === editing?.id}
              onClick={() => {
                if (!editing) {
                  return;
                }
                void patch(
                  editing,
                  {
                    fullName: editForm.fullName,
                    phone: editForm.phone,
                    email: editForm.email.trim() || null,
                  },
                  `แก้ข้อมูลของ ${editForm.fullName} แล้ว`,
                ).then(() => setEditing(null));
              }}
            >
              บันทึก
            </Button>
          </>
        }
      >
        <Stack gap="md">
          <TextField
            id="edit-member-name"
            label="ชื่อ-นามสกุล"
            value={editForm.fullName}
            onChange={(event) => setEditForm({ ...editForm, fullName: event.target.value })}
          />
          <TextField
            id="edit-member-phone"
            label="เบอร์โทร"
            inputMode="tel"
            className="ln-num"
            help="เปลี่ยนแล้วลูกค้าต้องใช้เบอร์ใหม่ในการเข้าสู่ระบบ"
            value={editForm.phone}
            onChange={(event) => setEditForm({ ...editForm, phone: event.target.value })}
          />
          <TextField
            id="edit-member-email"
            label="อีเมล"
            type="email"
            value={editForm.email}
            onChange={(event) => setEditForm({ ...editForm, email: event.target.value })}
          />
        </Stack>
      </Overlay>

      <Overlay
        open={resetFor !== null}
        onClose={() => setResetFor(null)}
        title={resetFor ? `ตั้งรหัสผ่านใหม่ให้ ${resetFor.fullName}` : ''}
        description="ลูกค้าจะใช้รหัสผ่านนี้เข้าสู่ระบบครั้งถัดไป"
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
          id="reset-member-password"
          label="รหัสผ่านใหม่"
          type="password"
          autoComplete="new-password"
          help="อย่างน้อย 8 ตัวอักษร"
          value={resetPassword}
          onChange={(event) => setResetPassword(event.target.value)}
        />
      </Overlay>

      <ConfirmDialog
        open={closing !== null}
        title="ปิดการใช้งานบัญชีนี้?"
        description={
          closing
            ? `${closing.fullName} จะเข้าสู่ระบบไม่ได้อีก จนกว่าจะเปิดกลับ — ประวัติการซื้อ คะแนน และพรีออเดอร์ที่ค้างอยู่ยังอยู่ครบ พนักงานยังค้นหาและส่งมอบของได้ตามปกติ`
            : undefined
        }
        confirmLabel="ปิดใช้งาน"
        busy={busyId !== null}
        onConfirm={() => {
          if (!closing) {
            return;
          }
          void patch(closing, { isActive: false }, `ปิดการใช้งาน ${closing.fullName} แล้ว`).then(() =>
            setClosing(null),
          );
        }}
        onCancel={() => setClosing(null)}
      />
    </Stack>
  );
}
