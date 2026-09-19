import { Navigate, Route, Routes, useParams } from "react-router-dom";
import AuthPortal from "@/components/AuthPortal";
import { UserHomeRoute } from "@/src/routes/UserHomeRoute";
import ResetPasswordPage from "@/app/auth/reset-password/page";

/** SPA routes — same paths as the former Next app router. */
export function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <div className="min-h-screen w-full bg-background font-sans text-foreground">
            <AuthPortal />
          </div>
        }
      />
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/auth/desktop" element={<Navigate to="/?view=desktop" replace />} />
      <Route path="/app" element={<Navigate to="/" replace />} />
      <Route path="/app/*" element={<Navigate to="/" replace />} />
      <Route path="/user/:username" element={<UserRedirect />} />
      <Route path="/auth/reset-password" element={<ResetPasswordPage />} />
      <Route path="/:username" element={<UserHomeRoute />} />
    </Routes>
  );
}

function UserRedirect() {
  const { username } = useParams();
  return <Navigate to={`/${username ?? ""}`} replace />;
}
