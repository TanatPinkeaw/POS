/**
 * Demo seed data.
 *
 * Idempotent: every write is an upsert keyed on a natural unique column, so
 * running it twice neither duplicates the catalogue nor resets a password that
 * someone changed.
 *
 * This is **demo** data — a fake shop, fake staff and 30 fake products — which
 * is why it refuses to run once the system has been set up for real. Run it
 * with:
 *
 *   npm run db:seed          refuses if a shop exists
 *   npm run db:seed:demo     seeds regardless (fresh development database)
 */
// Populates process.env and installs the BigInt JSON serialiser before Prisma
// is constructed at module scope.
import '../src/lib/env';

import { hash } from 'bcryptjs';

import { prisma } from '../src/lib/db';
import type { PrismaClient } from '../src/generated/prisma/client';
import {
  addBangkokDays,
  bangkokDateString,
  dateColumnFromDay,
  timeColumnFromClock,
} from '../src/lib/bangkok-time';
import { SYSTEM_USER_ID, SYSTEM_USER_NAME, SYSTEM_USER_PHONE } from '../src/lib/system-user';

const BCRYPT_ROUNDS = 10;

/** Demo passwords. Documented in the README; never used outside local dev. */
const DEMO_PASSWORD = 'password123';

interface SeedUser {
  phone: string;
  email: string | null;
  fullName: string;
  role: 'member' | 'employee' | 'admin';
  pointsBalance: number;
  id?: string;
}

const USERS: SeedUser[] = [
  {
    phone: '0800000001',
    email: 'admin@pos.local',
    fullName: 'สมชาย ผู้จัดการ',
    role: 'admin',
    pointsBalance: 0,
  },
  {
    phone: '0800000002',
    email: 'cashier@pos.local',
    fullName: 'มาลี แคชเชียร์',
    role: 'employee',
    pointsBalance: 0,
  },
  {
    phone: '0800000003',
    email: 'stock@pos.local',
    fullName: 'สมปอง สต็อก',
    role: 'employee',
    pointsBalance: 0,
  },
  {
    phone: '0900000001',
    email: 'member@pos.local',
    fullName: 'ลูกค้า ทดสอบ',
    role: 'member',
    pointsBalance: 250,
  },
  {
    phone: '0900000002',
    email: null,
    fullName: 'วีระ ขาประจำ',
    role: 'member',
    pointsBalance: 1200,
  },
];

interface SeedProduct {
  barcode: string;
  name: string;
  category: string;
  costPrice: number;
  salePrice: number;
  stockQty: number;
}

const CATEGORIES = ['เครื่องดื่ม', 'ขนมขบเคี้ยว', 'ของใช้ในบ้าน', 'อาหารพร้อมทาน'];

const PRODUCTS: SeedProduct[] = [
  { barcode: '8850000000012', name: 'น้ำเปล่า 600 มล.', category: 'เครื่องดื่ม', costPrice: 5.5, salePrice: 8, stockQty: 120 },
  { barcode: '8850000000029', name: 'น้ำโซดา 325 มล.', category: 'เครื่องดื่ม', costPrice: 7, salePrice: 12, stockQty: 80 },
  { barcode: '8850000000036', name: 'โค้ก กระป๋อง 325 มล.', category: 'เครื่องดื่ม', costPrice: 14, salePrice: 22, stockQty: 96 },
  { barcode: '8850000000043', name: 'เป๊ปซี่ กระป๋อง 325 มล.', category: 'เครื่องดื่ม', costPrice: 14, salePrice: 22, stockQty: 72 },
  { barcode: '8850000000050', name: 'ชาเขียว 500 มล.', category: 'เครื่องดื่ม', costPrice: 16, salePrice: 25, stockQty: 60 },
  { barcode: '8850000000067', name: 'น้ำส้ม 100% 250 มล.', category: 'เครื่องดื่ม', costPrice: 18, salePrice: 28, stockQty: 40 },
  { barcode: '8850000000074', name: 'กาแฟเย็นกระป๋อง 180 มล.', category: 'เครื่องดื่ม', costPrice: 16, salePrice: 25, stockQty: 55 },
  { barcode: '8850000000081', name: 'นมสด UHT 225 มล.', category: 'เครื่องดื่ม', costPrice: 11, salePrice: 17, stockQty: 90 },
  { barcode: '8850000000098', name: 'โยเกิร์ต 135 กรัม', category: 'เครื่องดื่ม', costPrice: 12, salePrice: 20, stockQty: 30 },

  { barcode: '8850000000104', name: 'มันฝรั่งทอด รสออริจินัล', category: 'ขนมขบเคี้ยว', costPrice: 15, salePrice: 25, stockQty: 65 },
  { barcode: '8850000000111', name: 'มันฝรั่งทอด รสปาปริก้า', category: 'ขนมขบเคี้ยว', costPrice: 15, salePrice: 25, stockQty: 50 },
  { barcode: '8850000000128', name: 'เวเฟอร์ช็อกโกแลต', category: 'ขนมขบเคี้ยว', costPrice: 8, salePrice: 15, stockQty: 100 },
  { barcode: '8850000000135', name: 'คุกกี้เนย 100 กรัม', category: 'ขนมขบเคี้ยว', costPrice: 18, salePrice: 30, stockQty: 45 },
  { barcode: '8850000000142', name: 'ลูกอมมิ้นต์', category: 'ขนมขบเคี้ยว', costPrice: 6, salePrice: 10, stockQty: 200 },
  { barcode: '8850000000159', name: 'ช็อกโกแลตแท่ง', category: 'ขนมขบเคี้ยว', costPrice: 20, salePrice: 35, stockQty: 40 },
  { barcode: '8850000000166', name: 'ถั่วลิสงอบ 40 กรัม', category: 'ขนมขบเคี้ยว', costPrice: 12, salePrice: 20, stockQty: 70 },
  { barcode: '8850000000173', name: 'ข้าวเกรียบกุ้ง', category: 'ขนมขบเคี้ยว', costPrice: 10, salePrice: 18, stockQty: 85 },

  { barcode: '8850000000180', name: 'ทิชชู่ม้วน 4 ม้วน', category: 'ของใช้ในบ้าน', costPrice: 42, salePrice: 65, stockQty: 35 },
  { barcode: '8850000000197', name: 'สบู่ก้อน 100 กรัม', category: 'ของใช้ในบ้าน', costPrice: 22, salePrice: 35, stockQty: 50 },
  { barcode: '8850000000203', name: 'ยาสีฟัน 100 กรัม', category: 'ของใช้ในบ้าน', costPrice: 38, salePrice: 59, stockQty: 28 },
  { barcode: '8850000000210', name: 'แชมพูซอง', category: 'ของใช้ในบ้าน', costPrice: 5, salePrice: 10, stockQty: 150 },
  { barcode: '8850000000227', name: 'ผงซักฟอกซอง', category: 'ของใช้ในบ้าน', costPrice: 7, salePrice: 12, stockQty: 130 },
  { barcode: '8850000000234', name: 'ถุงขยะ 30 ใบ', category: 'ของใช้ในบ้าน', costPrice: 25, salePrice: 42, stockQty: 40 },
  { barcode: '8850000000241', name: 'น้ำยาล้างจาน 450 มล.', category: 'ของใช้ในบ้าน', costPrice: 32, salePrice: 49, stockQty: 33 },

  { barcode: '8850000000258', name: 'ข้าวกะเพราไก่ กล่อง', category: 'อาหารพร้อมทาน', costPrice: 32, salePrice: 50, stockQty: 24 },
  { barcode: '8850000000265', name: 'ข้าวผัดหมู กล่อง', category: 'อาหารพร้อมทาน', costPrice: 32, salePrice: 50, stockQty: 20 },
  { barcode: '8850000000272', name: 'แซนด์วิชทูน่า', category: 'อาหารพร้อมทาน', costPrice: 22, salePrice: 35, stockQty: 18 },
  { barcode: '8850000000289', name: 'บะหมี่กึ่งสำเร็จรูป', category: 'อาหารพร้อมทาน', costPrice: 6, salePrice: 10, stockQty: 180 },
  { barcode: '8850000000296', name: 'โจ๊กกึ่งสำเร็จรูป', category: 'อาหารพร้อมทาน', costPrice: 9, salePrice: 15, stockQty: 90 },
  { barcode: '8850000000302', name: 'ไข่ต้ม 2 ฟอง', category: 'อาหารพร้อมทาน', costPrice: 12, salePrice: 20, stockQty: 36 },
];

/**
 * Refuses to pour demo data into a shop somebody is actually using.
 *
 * Adding 30 invented products, four staff accounts and a fabricated roster to a
 * live shop is not a mistake you can clean up by re-running something — the
 * only real fix is restoring a backup. The check is cheap and the alternative
 * is unrecoverable, so it is not left to a warning in the documentation.
 */
async function assertSafeToSeed(prisma: PrismaClient): Promise<void> {
  if (process.argv.includes('--force')) {
    console.log('Seeding demo data as requested (--force).');
    return;
  }

  if ((await prisma.shops.count()) === 0) {
    return;
  }

  console.error(
    [
      '',
      'This deployment has already been set up, so the demo seed will not run.',
      '',
      'The seed adds a fictional shop, 4 staff accounts and 30 products. Adding',
      'those to a shop in use is not something you can undo by re-seeding.',
      '',
      'To add your own catalogue, sign in as an administrator and use',
      'สินค้าและสต็อก → นำเข้าสินค้าจากไฟล์, or start the setup wizard again on a',
      'fresh database.',
      '',
      'If this really is a throwaway development database:',
      '  npm run db:seed:demo',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  /*
   * The application's own client rather than one built here.
   *
   * A second `new PrismaPg({ connectionString })` was a second place the
   * `?schema=` parameter could be — and was — dropped, since the pg driver
   * accepts it and ignores it: seeding `DATABASE_URL=…?schema=smoke` wrote the
   * whole demo catalogue into `public`, and a server pointed at `smoke` then
   * looked at an empty database. One client, built in one place, means the seed
   * writes to exactly the schema the application reads.
   */
  try {
    await assertSafeToSeed(prisma);

    // ---- automated actor -------------------------------------------------
    // stock_logs.changed_by is NOT NULL, so system-driven expiries need a user
    // to attribute the movement to.
    await prisma.users.upsert({
      where: { id: SYSTEM_USER_ID },
      update: {},
      create: {
        id: SYSTEM_USER_ID,
        phone: SYSTEM_USER_PHONE,
        email: null,
        password_hash: await hash(`system-${SYSTEM_USER_ID}`, BCRYPT_ROUNDS),
        full_name: SYSTEM_USER_NAME,
        role: 'admin',
        is_active: false,
      },
    });

    // ---- people ----------------------------------------------------------
    const passwordHash = await hash(DEMO_PASSWORD, BCRYPT_ROUNDS);
    const usersByRole: Record<string, number> = {};

    for (const user of USERS) {
      await prisma.users.upsert({
        where: { phone: user.phone },
        update: { full_name: user.fullName, role: user.role },
        create: {
          phone: user.phone,
          email: user.email,
          password_hash: passwordHash,
          full_name: user.fullName,
          role: user.role,
          points_balance: user.pointsBalance,
        },
      });
      usersByRole[user.role] = (usersByRole[user.role] ?? 0) + 1;
    }

    // ---- catalogue -------------------------------------------------------
    const categoryIds = new Map<string, number>();
    for (const name of CATEGORIES) {
      const existing = await prisma.categories.findFirst({ where: { name } });
      const category = existing ?? (await prisma.categories.create({ data: { name } }));
      categoryIds.set(name, category.id);
    }

    for (const product of PRODUCTS) {
      await prisma.products.upsert({
        where: { barcode: product.barcode },
        update: {
          name: product.name,
          cost_price: product.costPrice,
          sale_price: product.salePrice,
          category_id: categoryIds.get(product.category) ?? null,
        },
        create: {
          barcode: product.barcode,
          name: product.name,
          description: null,
          cost_price: product.costPrice,
          sale_price: product.salePrice,
          stock_qty: product.stockQty,
          category_id: categoryIds.get(product.category) ?? null,
          is_active: true,
        },
      });
    }

    // ---- roster, plus one day of attendance history ----------------------
    // The SRS §8 `employee_attendance` export joins `work_schedules` to
    // `time_logs`, so a demo with neither would export headers only. Rosters
    // upsert on (employee, day); a day that already has a log is left alone, so
    // re-seeding never doubles someone's hours.
    const admin = await prisma.users.findUnique({
      where: { phone: '0800000001' },
      select: { id: true },
    });
    if (!admin) {
      throw new Error('Seed expected the admin account to exist');
    }

    const today = bangkokDateString(new Date());
    const staff = await prisma.users.findMany({
      where: { phone: { in: ['0800000002', '0800000003'] } },
      select: { id: true },
    });

    let rosterCount = 0;
    let logCount = 0;

    // Yesterday is included so the seeded attendance log below has a roster to
    // be measured against; without it the demo timesheet shows blank scheduled
    // columns and no lateness figure.
    const rosterDays = 8;

    for (const member of staff) {
      for (let offset = -1; offset < rosterDays - 1; offset += 1) {
        const day = addBangkokDays(today, offset);
        await prisma.work_schedules.upsert({
          where: {
            employee_id_shift_date: {
              employee_id: member.id,
              shift_date: dateColumnFromDay(day),
            },
          },
          update: {},
          create: {
            employee_id: member.id,
            shift_date: dateColumnFromDay(day),
            start_time: timeColumnFromClock('09:00'),
            end_time: timeColumnFromClock('17:30'),
            note: 'กะเช้า',
            created_by: admin.id,
          },
        });
        rosterCount += 1;
      }

      // One completed shift yesterday: 08:55–17:35 against a 09:00–17:30 roster,
      // which the timesheet reads as five minutes early and five minutes over.
      const yesterday = addBangkokDays(today, -1);
      const dayStart = new Date(`${yesterday}T00:00:00+07:00`);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      const existingLogs = await prisma.time_logs.count({
        where: { employee_id: member.id, check_in: { gte: dayStart, lt: dayEnd } },
      });
      if (existingLogs === 0) {
        await prisma.time_logs.create({
          data: {
            employee_id: member.id,
            check_in: new Date(`${yesterday}T08:55:00+07:00`),
            check_out: new Date(`${yesterday}T17:35:00+07:00`),
            note: 'กะเช้า',
          },
        });
        logCount += 1;
      }
    }

    const productCount = await prisma.products.count();
    const userCount = await prisma.users.count();

    console.log(
      [
        'Seed complete.',
        `  users      ${userCount} (${Object.entries(usersByRole)
          .map(([role, count]) => `${count} ${role}`)
          .join(', ')})`,
        `  categories ${categoryIds.size}`,
        `  products   ${productCount}`,
        `  schedules  ${rosterCount} (${rosterDays} days × ${staff.length} staff)`,
        `  time logs  ${logCount} (yesterday, one per staff member)`,
        '',
        `Sign in with any phone below and the password "${DEMO_PASSWORD}":`,
        ...USERS.map((user) => `  ${user.role.padEnd(8)} ${user.phone}  ${user.fullName}`),
      ].join('\n'),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
