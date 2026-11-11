/** A friendly empty screen: a small bobbing icon, a title and a nudge. */
export function Empty({ icon = '✨', title, hint, small }) {
  return (
    <div class={'empty' + (small ? ' small' : '')}>
      <div class="ico" aria-hidden="true">{icon}</div>
      {title && <b>{title}</b>}
      {hint && <span class="head">{hint}</span>}
    </div>
  );
}
