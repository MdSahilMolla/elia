import { expect, test } from 'bun:test'
import { assertReadOnlySql, stripSqlLiterals } from './sqlguard.ts'

test('plain reads, CTEs, window functions, and REPLACE() pass', () => {
  expect(assertReadOnlySql('select * from orders;')).toBe('select * from orders')
  expect(() => assertReadOnlySql("WITH m AS (SELECT customer_id, sum(amount) s FROM orders GROUP BY 1) SELECT *, rank() over (order by s desc) FROM m")).not.toThrow()
  expect(() => assertReadOnlySql("select replace(name, 'a', 'b') from t")).not.toThrow()
  expect(() => assertReadOnlySql("select 'drop table x; delete' as note")).not.toThrow()
  expect(() => assertReadOnlySql('explain select 1')).not.toThrow()
  expect(() => assertReadOnlySql("pragma table_info('orders')")).not.toThrow()
})

test('writes, stacked statements, locks, and file functions are refused', () => {
  for (const sql of [
    'delete from orders',
    'select 1; drop table orders',
    'with x as (delete from t returning *) select * from x',
    'select * from t for update',
    'select * into backup from t',
    "select pg_read_file('/etc/passwd')",
    "select * from read_csv_auto('/etc/passwd')",
    'explain analyze select 1',
    'explain delete from t',
    "select load_file('/etc/passwd')",
    'select nextval(\'s\')',
    'insert into t values (1)',
    'replace into t values (1)',
  ]) expect(() => assertReadOnlySql(sql)).toThrow()
})

test('comments and quoted text cannot smuggle structure past the guard', () => {
  expect(stripSqlLiterals("select 'a;b' -- ; drop\n from t /* ; */")).not.toContain(';')
  expect(() => assertReadOnlySql('select 1 /* */; drop table t')).toThrow()
})
