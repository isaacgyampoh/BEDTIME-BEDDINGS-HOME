import { createClient } from '@supabase/supabase-js'
const url = 'https://wqkgfvmvuljzexhevlnp.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indxa2dmdm12dWxqemV4aGV2bG5wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwMTc5NzEsImV4cCI6MjEwMDU5Mzk3MX0.BOAaKOnE_RaZtTBa_GED793Xn5hdjRxT4hEvG_Ivkpo'
export const supabase = createClient(url, key)
