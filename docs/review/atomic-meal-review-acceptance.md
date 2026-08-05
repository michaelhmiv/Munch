# Atomic meal review acceptance criteria

- Clear unbranded plated-food photos do not force a homemade-versus-restaurant question.
- Visible scale references are used when available.
- Only material uncertainty creates a clarification question; other uncertainty is shown as an assumption.
- Initial review creation is one atomic server mutation.
- One-question resolution is one additional atomic mutation.
- Final save still requires explicit confirmation and remains idempotent.
- Review UI supports confirm, edit, and cancel on mobile and desktop.
- Legacy granular tools remain compatible.
- Migration, RLS, concurrency, confirmation, widget, and container tests pass.
- Reported performance improvements are based on observed same-environment measurements and clearly exclude unmeasured image/model time.
