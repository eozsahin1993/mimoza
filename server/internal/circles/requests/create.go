package requests

// A join request carries no body: who is asking comes from the session,
// which circle from the code in the path, and the key the circle is
// sealed to them with from their own account.
type CreateHandler struct{ Service *Service }
