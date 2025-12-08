import { redirect } from 'next/navigation'

export default function Home() {
  // Redirect to all studies list by default
  redirect('/studies')
}
