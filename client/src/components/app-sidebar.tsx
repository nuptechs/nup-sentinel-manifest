import { LayoutDashboard, FolderUp, FileSearch, Map, Network, GitCompare, GitBranch, ShieldAlert, Settings, Ruler, Target, Workflow } from "lucide-react";
import { useLocation, Link } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";

const navItems = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  // A superfície única de decisão: responde saúde/prova/ponto-cego/tendência
  // numa página só. Fica no topo porque é por onde se começa a olhar.
  { title: "Decisão", url: "/decisao", icon: Target },
  { title: "Upload Project", url: "/upload", icon: FolderUp },
  { title: "Catalog", url: "/catalog", icon: FileSearch },
  { title: "System Explorer", url: "/insights", icon: Map },
  { title: "System Map", url: "/system-map", icon: Network },
  { title: "Diagramas", url: "/diagrams", icon: Workflow },
  { title: "Diff Viewer", url: "/diff", icon: GitCompare },
  { title: "Git Integration", url: "/git", icon: GitBranch },
  { title: "Security Audit", url: "/security", icon: ShieldAlert },
  { title: "Conventions", url: "/conventions", icon: Ruler },
  { title: "Settings", url: "/settings", icon: Settings },
];

export function AppSidebar() {
  const [location] = useLocation();

  return (
    <Sidebar>
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary">
            <FileSearch className="h-4 w-4 text-primary-foreground" />
          </div>
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Manifest</h2>
            <p className="text-xs text-muted-foreground">Code-to-Permission Catalog</p>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive =
                  item.url === "/"
                    ? location === "/"
                    : location.startsWith(item.url);
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      data-active={isActive}
                      className="data-[active=true]:bg-sidebar-accent"
                    >
                      <Link href={item.url} data-testid={`link-nav-${item.title.toLowerCase().replace(/\s/g, '-')}`}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4">
        <p className="text-xs text-muted-foreground">
          Static Code Intelligence Tool
        </p>
      </SidebarFooter>
    </Sidebar>
  );
}
