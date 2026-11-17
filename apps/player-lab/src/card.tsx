// Shared panel chrome for the Player Lab.
export function Card(props: { title: string; children?: unknown; actions?: unknown; badge?: string }) {
  return (
    <section className="card" aria-label={props.title}>
      <header className="card-h">
        <h2>{props.title}</h2>
        {props.badge && <span className="badge warn">{props.badge}</span>}
        {props.actions ? <div className="card-actions">{props.actions}</div> : null}
      </header>
      <div className="card-b">{props.children}</div>
    </section>
  );
}
