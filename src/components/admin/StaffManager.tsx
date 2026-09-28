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
 * reads as a rule rather than a bug.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Alert, Badge, Card, EmptyState } from '@/components/hope/ui';
import { apiPatch, apiPost } from '@/lib/client-api';

export interface StaffRow {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  role: 'employee' | 'admin';
  isActive: boolean;
}

const ROLE_LABEL: Record<StaffRow['role'], string> = {
  admin: 'ผู้จัดการ',
  employee: 'พนักงาน',
};

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
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');

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
        [...current, created].sort((left, right) => left.fullName.localeCompare(right.fullName, 'th')),
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

  async function patch(member: StaffRow, payload: Record<string, unknown>, successText: string): Promise<void> {
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
    if (member.isActive && !window.confirm(`ปิดการใช้งานบัญชีของ ${member.fullName}?`)) {
      return;
    }
    void patch(
      member,
      { isActive: !member.isActive },
      member.isActive ? `ปิดการใช้งาน ${member.fullName} แล้ว` : `เปิดการใช้งาน ${member.fullName} แล้ว`,
    );
  }

  return (
    <div className="row g-4">
      <div className="col-12 col-xl-5">
        <Card title="เพิ่มพนักงาน" subtitle="พนักงานใช้เบอร์โทรเข้าสู่ระบบ">
          <div className="row g-3">
            <div className="col-12 col-md-6">
              <label className="form-label" htmlFor="staff-name">
                ชื่อ-นามสกุล <span className="text-danger">*</span>
              </label>
              <input
                id="staff-name"
                name="fullName"
                autoComplete="name"
                className="form-control"
                value={form.fullName}
                onChange={(event) => setForm({ ...form, fullName: event.target.value })}
              />
            </div>
            <div className="col-12 col-md-6">
              <label className="form-label" htmlFor="staff-phone">
                เบอร์โทร <span className="text-danger">*</span>
              </label>
              <input
                id="staff-phone"
                name="phone"
                autoComplete="tel"
                className="form-control"
                value={form.phone}
                onChange={(event) => setForm({ ...form, phone: event.target.value })}
              />
            </div>
            <div className="col-12 col-md-6">
              <label className="form-label" htmlFor="staff-role">
                ตำแหน่ง
              </label>
              <select
                id="staff-role"
                name="role"
                autoComplete="off"
                className="form-select"
                value={form.role}
                onChange={(event) => setForm({ ...form, role: event.target.value as StaffRow['role'] })}
              >
                <option value="employee">พนักงาน (ขายหน้าร้าน)</option>
                <option value="admin">ผู้จัดการ (จัดการได้ทั้งหมด)</option>
              </select>
            </div>
            <div className="col-12 col-md-6">
              <label className="form-label" htmlFor="staff-email">
                อีเมล
              </label>
              <input
                id="staff-email"
                name="email"
                type="email"
                autoComplete="email"
                className="form-control"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
              />
            </div>
            <div className="col-12">
              <label className="form-label" htmlFor="staff-password">
                รหัสผ่านชั่วคราว <span className="text-danger">*</span>
              </label>
              <input
                id="staff-password"
                name="password"
                type="password"
                autoComplete="new-password"
                className="form-control"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
              />
              <div className="form-text">อย่างน้อย 8 ตัวอักษร — แจ้งพนักงานแล้วให้เปลี่ยนเองภายหลัง</div>
            </div>
          </div>

          <div className="d-flex justify-content-end mt-4">
            <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={creating}>
              {creating ? 'กำลังบันทึก…' : 'เพิ่มพนักงาน'}
            </button>
          </div>
        </Card>

        {notice && (
          <Alert tone={notice.tone} className="mt-4 mb-0">
            {notice.text}
          </Alert>
        )}
      </div>

      <div className="col-12 col-xl-7">
        <Card title="พนักงานทั้งหมด" subtitle={`${staff.length} บัญชี · ผู้จัดการที่ใช้งานอยู่ ${activeAdmins} คน`}>
          {staff.length === 0 ? (
            <EmptyState title="ยังไม่มีพนักงาน" description="เพิ่มพนักงานคนแรกจากฟอร์มด้านซ้าย" />
          ) : (
            <div className="table-responsive">
              <table className="table align-middle mb-0">
                <thead>
                  <tr>
                    <th scope="col">ชื่อ</th>
                    <th scope="col">เบอร์โทร</th>
                    <th scope="col">ตำแหน่ง</th>
                    <th scope="col">สถานะ</th>
                    <th scope="col">
                      <span className="visually-hidden">การจัดการ</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((member) => {
                    const isSelf = member.id === currentUserId;
                    const lastAdmin = isLastAdmin(member);
                    const busy = busyId === member.id;

                    return (
                      <tr key={member.id}>
                        <td>
                          <span className="d-block">{member.fullName}</span>
                          {member.email && <span className="text-muted small">{member.email}</span>}
                          {isSelf && (
                            <Badge tone="info" className="ms-2">
                              คุณ
                            </Badge>
                          )}
                        </td>
                        <td className="pos-numeric">{member.phone}</td>
                        <td>
                          <select
                            className="form-select form-select-sm"
                            aria-label={`ตำแหน่งของ ${member.fullName}`}
                            name={`role-${member.id}`}
                            autoComplete="off"
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
                          </select>
                          {isSelf && <span className="text-muted small">เปลี่ยนของตัวเองไม่ได้</span>}
                        </td>
                        <td>
                          {member.isActive ? (
                            <Badge tone="success">ใช้งานอยู่</Badge>
                          ) : (
                            <Badge tone="secondary">ปิดใช้งาน</Badge>
                          )}
                        </td>
                        <td className="text-end">
                          <div className="d-flex justify-content-end gap-2 flex-wrap">
                            <button
                              type="button"
                              className="btn btn-sm btn-soft-secondary"
                              disabled={busy}
                              onClick={() => {
                                setResetFor(resetFor === member.id ? null : member.id);
                                setResetPassword('');
                              }}
                            >
                              ตั้งรหัสผ่านใหม่
                            </button>
                            <button
                              type="button"
                              className={`btn btn-sm ${member.isActive ? 'btn-soft-danger' : 'btn-soft-success'}`}
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
                            </button>
                          </div>

                          {resetFor === member.id && (
                            <div className="d-flex gap-2 mt-2">
                              <label className="visually-hidden" htmlFor={`reset-${member.id}`}>
                                รหัสผ่านใหม่ของ {member.fullName}
                              </label>
                              <input
                                id={`reset-${member.id}`}
                                name={`reset-password-${member.id}`}
                                type="password"
                                autoComplete="new-password"
                                className="form-control form-control-sm"
                                placeholder="รหัสผ่านใหม่ 8 ตัวอักษรขึ้นไป"
                                value={resetPassword}
                                onChange={(event) => setResetPassword(event.target.value)}
                              />
                              <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                disabled={busy || resetPassword.length < 8}
                                onClick={() => {
                                  void patch(
                                    member,
                                    { password: resetPassword },
                                    `ตั้งรหัสผ่านใหม่ให้ ${member.fullName} แล้ว`,
                                  ).then(() => setResetFor(null));
                                }}
                              >
                                ยืนยัน
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-muted small mb-0 mt-3">
            ระบบไม่ให้ปิดการใช้งานผู้จัดการคนสุดท้าย และไม่ให้คุณลดตำแหน่งตัวเอง
            เพื่อไม่ให้ร้านถูกล็อกออกจากหน้าตั้งค่า
          </p>
        </Card>
      </div>
    </div>
  );
}
