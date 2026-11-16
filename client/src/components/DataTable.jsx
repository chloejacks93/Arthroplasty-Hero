import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Inbox } from 'lucide-react';

/**
 * Server-driven data table: sticky header, sortable columns, pagination,
 * stacked rows on phones. Columns:
 *   { key, header, render(row), sortKey?, align?, mobile?: 'primary'|'status'|'full'|'hide', label? }
 */
export function DataTable({ columns, rows, loading, sort, dir, onSort, onRowClick, empty, rowKey = 'id', compact, auto }) {
  const SortIcon = ({ active }) => (!active ? <ArrowUpDown /> : dir === 'asc' ? <ArrowUp /> : <ArrowDown />);

  return (
    <div className={`table-wrap${auto ? ' auto' : ''}`}>
      <table className={`data responsive${compact ? ' compact' : ''}`}>
        <thead>
          <tr>
            {columns.map((c) => {
              const sorted = c.sortKey && sort === c.sortKey;
              return (
                <th
                  key={c.key}
                  className={`${c.sortKey ? 'sortable' : ''} ${sorted ? 'sorted' : ''} ${c.align === 'right' ? 'right' : ''}`}
                  onClick={c.sortKey ? () => onSort(c.sortKey) : undefined}
                  aria-sort={sorted ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  scope="col"
                >
                  <span className="th">
                    {c.header}
                    {c.sortKey && <SortIcon active={sorted} />}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading && !rows?.length
            ? Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.key}><div className="skeleton" style={{ height: 10, width: `${40 + ((i * 13 + c.key.length * 7) % 50)}%` }} /></td>
                  ))}
                </tr>
              ))
            : rows?.map((r) => (
                <tr key={r[rowKey]} className={onRowClick ? 'clickable' : ''} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={[c.align === 'right' && 'right', c.className, c.mobile && c.mobile !== 'hide' && `m-${c.mobile}`].filter(Boolean).join(' ')}
                      data-hide-mobile={c.mobile === 'hide' ? '' : undefined}
                      data-label={c.mobile === 'full' ? c.label || c.header : undefined}
                    >
                      {c.render ? c.render(r) : r[c.key] ?? <span className="subtle">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
      {!loading && rows?.length === 0 && (
        <div className="empty">
          <Inbox aria-hidden />
          <strong>{empty?.title || 'No records'}</strong>
          <div>{empty?.body || 'Nothing matches the current filters.'}</div>
        </div>
      )}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="table-foot">
      <span className="num">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()} assets
      </span>
      <div className="pager">
        <button className="btn" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft />
        </button>
        <span className="page-ind">Page {page} of {pages}</span>
        <button className="btn" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          <ChevronRight />
        </button>
      </div>
    </div>
  );
}
