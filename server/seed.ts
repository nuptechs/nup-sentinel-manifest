import { storage } from "./storage";
import { db } from "./db";
import { projects } from "@shared/schema";
import { sql } from "drizzle-orm";

const SAMPLE_VUE_COMPONENT = `<template>
  <div class="user-management">
    <el-button @click="fetchUsers">Refresh Users</el-button>
    <el-button type="primary" @click="showCreateDialog">Create User</el-button>
    
    <el-table :data="users" style="width: 100%">
      <el-table-column prop="name" label="Name" />
      <el-table-column prop="email" label="Email" />
      <el-table-column prop="status" label="Status" />
      <el-table-column label="Actions">
        <template #default="scope">
          <el-button size="small" @click="editUser(scope.row)">Edit</el-button>
          <el-button size="small" type="danger" @click="deleteUser(scope.row.id)">Delete</el-button>
          <el-button size="small" @click="toggleStatus(scope.row)">Toggle Status</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog title="Create User" v-model="createDialogVisible">
      <el-form @submit.prevent="submitCreateForm">
        <el-form-item label="Name">
          <el-input v-model="newUser.name" />
        </el-form-item>
        <el-form-item label="Email">
          <el-input v-model="newUser.email" />
        </el-form-item>
        <el-button type="primary" @click="submitCreateForm">Save</el-button>
      </el-form>
    </el-dialog>
  </div>
</template>

<script>
import axios from 'axios';

export default {
  data() {
    return {
      users: [],
      createDialogVisible: false,
      newUser: { name: '', email: '' }
    };
  },
  methods: {
    async fetchUsers() {
      const response = await axios.get('/api/users');
      this.users = response.data;
    },
    async submitCreateForm() {
      await axios.post('/api/users', this.newUser);
      this.createDialogVisible = false;
      this.fetchUsers();
    },
    async editUser(user) {
      await axios.put(\`/api/users/\${user.id}\`, user);
      this.fetchUsers();
    },
    async deleteUser(id) {
      await axios.delete(\`/api/users/\${id}\`);
      this.fetchUsers();
    },
    async toggleStatus(user) {
      await axios.patch(\`/api/users/\${user.id}/status\`, { active: !user.active });
      this.fetchUsers();
    },
    showCreateDialog() {
      this.createDialogVisible = true;
    }
  },
  mounted() {
    this.fetchUsers();
  }
};
</script>`;

const SAMPLE_VUE_ROUTER = `import Vue from 'vue';
import Router from 'vue-router';
import UserManagement from '@/views/UserManagement.vue';
import OrderDashboard from '@/views/OrderDashboard.vue';
import Settings from '@/views/Settings.vue';
import Login from '@/views/Login.vue';

Vue.use(Router);

export default new Router({
  routes: [
    { path: '/users', component: UserManagement },
    { path: '/orders', component: OrderDashboard },
    { path: '/settings', component: Settings },
    { path: '/login', component: Login },
  ]
});`;

const SAMPLE_ORDER_VUE = `<template>
  <div class="order-dashboard">
    <el-button @click="fetchOrders">Refresh</el-button>
    <el-button type="success" @click="exportOrders">Export CSV</el-button>
    
    <el-menu-item @click="navigateToReports">Reports</el-menu-item>
    
    <el-table :data="orders">
      <el-table-column prop="orderId" label="Order ID" />
      <el-table-column prop="total" label="Total" />
      <el-table-column label="Actions">
        <template #default="scope">
          <el-button size="small" @click="viewOrder(scope.row)">View</el-button>
          <el-button size="small" type="warning" @click="cancelOrder(scope.row.id)">Cancel</el-button>
          <el-button size="small" @click="approveOrder(scope.row.id)">Approve</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script>
import axios from 'axios';

export default {
  methods: {
    async fetchOrders() {
      const resp = await axios.get('/api/orders');
      this.orders = resp.data;
    },
    async cancelOrder(id) {
      await axios.patch(\`/api/orders/\${id}/cancel\`);
      this.fetchOrders();
    },
    async approveOrder(id) {
      await axios.post(\`/api/orders/\${id}/approve\`);
      this.fetchOrders();
    },
    async exportOrders() {
      const resp = await axios.get('/api/orders/export');
      window.open(resp.data.url);
    },
    navigateToReports() {
      this.$router.push('/reports');
    }
  }
};
</script>`;

const SAMPLE_USER_CONTROLLER = `package com.example.app.controller;

import com.example.app.model.User;
import com.example.app.service.UserService;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {

    @Autowired
    private UserService userService;

    @GetMapping("")
    public ResponseEntity<List<User>> getAllUsers() {
        return ResponseEntity.ok(userService.findAll());
    }

    @GetMapping("/{id}")
    public ResponseEntity<User> getUserById(@PathVariable Long id) {
        return ResponseEntity.ok(userService.findById(id));
    }

    @PostMapping("")
    public ResponseEntity<User> createUser(@RequestBody User user) {
        return ResponseEntity.ok(userService.createUser(user));
    }

    @PutMapping("/{id}")
    public ResponseEntity<User> updateUser(@PathVariable Long id, @RequestBody User user) {
        return ResponseEntity.ok(userService.updateUser(id, user));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteUser(@PathVariable Long id) {
        userService.deleteUser(id);
        return ResponseEntity.noContent().build();
    }

    @PatchMapping("/{id}/status")
    public ResponseEntity<User> toggleUserStatus(@PathVariable Long id, @RequestBody Map<String, Boolean> body) {
        return ResponseEntity.ok(userService.toggleStatus(id, body.get("active")));
    }
}`;

const SAMPLE_ORDER_CONTROLLER = `package com.example.app.controller;

import com.example.app.service.OrderService;
import com.example.app.service.NotificationService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    @Autowired
    private OrderService orderService;

    @Autowired
    private NotificationService notificationService;

    @GetMapping("")
    public ResponseEntity<?> getAllOrders() {
        return ResponseEntity.ok(orderService.findAllOrders());
    }

    @PatchMapping("/{id}/cancel")
    public ResponseEntity<?> cancelOrder(@PathVariable Long id) {
        orderService.cancelOrder(id);
        notificationService.sendOrderCancellation(id);
        return ResponseEntity.ok().build();
    }

    @PostMapping("/{id}/approve")
    public ResponseEntity<?> approveOrder(@PathVariable Long id) {
        orderService.approveOrder(id);
        notificationService.sendOrderApproval(id);
        return ResponseEntity.ok().build();
    }

    @GetMapping("/export")
    public ResponseEntity<?> exportOrders() {
        return ResponseEntity.ok(orderService.exportToCSV());
    }
}`;

const SAMPLE_NOTIFICATION_SERVICE = `package com.example.app.service;

import com.example.app.model.Notification;
import com.example.app.model.Order;
import com.example.app.repository.NotificationRepository;
import com.example.app.repository.OrderRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

@Service
public class NotificationService {

    @Autowired
    private NotificationRepository notificationRepository;

    @Autowired
    private OrderRepository orderRepository;

    public void sendOrderCancellation(Long orderId) {
        Notification notif = createNotification(orderId, "ORDER_CANCELLED");
        notificationRepository.save(notif);
        logOrderEvent(orderId, "CANCELLED");
    }

    public void sendOrderApproval(Long orderId) {
        Notification notif = createNotification(orderId, "ORDER_APPROVED");
        notificationRepository.save(notif);
        logOrderEvent(orderId, "APPROVED");
    }

    private Notification createNotification(Long orderId, String type) {
        Notification notif = new Notification();
        notif.setType(type);
        notif.setOrderId(orderId);
        return notif;
    }

    private void logOrderEvent(Long orderId, String event) {
        Order order = orderRepository.findById(orderId).orElseThrow();
        order.setLastEvent(event);
        orderRepository.save(order);
    }
}`;

const SAMPLE_USER_SERVICE = `package com.example.app.service;

import com.example.app.model.AuditLog;
import com.example.app.model.User;
import com.example.app.repository.AuditLogRepository;
import com.example.app.repository.UserRepository;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

@Service
public class UserService {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AuditLogRepository auditLogRepository;

    public List<User> findAll() {
        return userRepository.findAll();
    }

    public User findById(Long id) {
        return userRepository.findById(id).orElseThrow();
    }

    public User createUser(User user) {
        User saved = userRepository.save(user);
        auditLogRepository.save(new AuditLog("USER_CREATED", saved.getId()));
        return saved;
    }

    public User updateUser(Long id, User user) {
        User existing = userRepository.findById(id).orElseThrow();
        existing.setName(user.getName());
        existing.setEmail(user.getEmail());
        auditLogRepository.save(new AuditLog("USER_UPDATED", id));
        return userRepository.save(existing);
    }

    public void deleteUser(Long id) {
        userRepository.deleteById(id);
        auditLogRepository.save(new AuditLog("USER_DELETED", id));
    }

    public User toggleStatus(Long id, boolean active) {
        User user = userRepository.findById(id).orElseThrow();
        user.setActive(active);
        auditLogRepository.save(new AuditLog("USER_STATUS_CHANGED", id));
        return userRepository.save(user);
    }
}`;

const SAMPLE_ORDER_SERVICE = `package com.example.app.service;

import com.example.app.model.Order;
import com.example.app.repository.OrderRepository;
import com.example.app.repository.PaymentRepository;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

@Service
public class OrderService {

    @Autowired
    private OrderRepository orderRepository;

    @Autowired
    private PaymentRepository paymentRepository;

    public List<Order> findAllOrders() {
        return orderRepository.findAll();
    }

    public void cancelOrder(Long id) {
        Order order = orderRepository.findById(id).orElseThrow();
        order.setStatus("CANCELLED");
        orderRepository.save(order);
        paymentRepository.deleteByOrderId(id);
    }

    public void approveOrder(Long id) {
        Order order = orderRepository.findById(id).orElseThrow();
        order.setStatus("APPROVED");
        orderRepository.save(order);
    }

    public String exportToCSV() {
        List<Order> orders = orderRepository.findAll();
        return "exported";
    }
}`;

const SAMPLE_USER_ENTITY = `package com.example.app.model;

import jakarta.persistence.*;

@Entity
@Table(name = "users")
public class User {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false, unique = true)
    private String email;

    @Column
    private boolean active;

    @Column
    private String role;

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
    public boolean isActive() { return active; }
    public void setActive(boolean active) { this.active = active; }
    public String getRole() { return role; }
    public void setRole(String role) { this.role = role; }
}`;

const SAMPLE_ORDER_ENTITY = `package com.example.app.model;

import jakarta.persistence.*;
import java.math.BigDecimal;

@Entity
@Table(name = "orders")
public class Order {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String orderId;

    @Column
    private BigDecimal total;

    @Column
    private String status;

    @Column
    private Long userId;

    @Column
    private String lastEvent;

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getOrderId() { return orderId; }
    public void setOrderId(String orderId) { this.orderId = orderId; }
    public BigDecimal getTotal() { return total; }
    public void setTotal(BigDecimal total) { this.total = total; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public Long getUserId() { return userId; }
    public void setUserId(Long userId) { this.userId = userId; }
    public String getLastEvent() { return lastEvent; }
    public void setLastEvent(String event) { this.lastEvent = event; }
}`;

const SAMPLE_NOTIFICATION_ENTITY = `package com.example.app.model;

import jakarta.persistence.*;

@Entity
@Table(name = "notifications")
public class Notification {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column
    private String type;

    @Column
    private Long orderId;

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getType() { return type; }
    public void setType(String type) { this.type = type; }
    public Long getOrderId() { return orderId; }
    public void setOrderId(Long orderId) { this.orderId = orderId; }
}`;

const SAMPLE_AUDIT_LOG_ENTITY = `package com.example.app.model;

import jakarta.persistence.*;

@Entity
@Table(name = "audit_logs")
public class AuditLog {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column
    private String action;

    @Column
    private Long entityId;

    public AuditLog() {}

    public AuditLog(String action, Long entityId) {
        this.action = action;
        this.entityId = entityId;
    }

    public Long getId() { return id; }
    public String getAction() { return action; }
    public Long getEntityId() { return entityId; }
}`;

const SAMPLE_USER_REPOSITORY = `package com.example.app.repository;

import com.example.app.model.User;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface UserRepository extends JpaRepository<User, Long> {
}`;

const SAMPLE_ORDER_REPOSITORY = `package com.example.app.repository;

import com.example.app.model.Order;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface OrderRepository extends JpaRepository<Order, Long> {
}`;

const SAMPLE_PAYMENT_REPOSITORY = `package com.example.app.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface PaymentRepository extends JpaRepository<Object, Long> {
    void deleteByOrderId(Long orderId);
}`;

const SAMPLE_NOTIFICATION_REPOSITORY = `package com.example.app.repository;

import com.example.app.model.Notification;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface NotificationRepository extends JpaRepository<Notification, Long> {
}`;

const SAMPLE_AUDIT_LOG_REPOSITORY = `package com.example.app.repository;

import com.example.app.model.AuditLog;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface AuditLogRepository extends JpaRepository<AuditLog, Long> {
}`;

export async function seedDatabase() {
  const [existing] = await db.select({ count: sql<number>`count(*)::int` }).from(projects);
  if (existing.count > 0) return;

  console.log("Seeding database with sample project...");

  const project = await storage.createProject({
    name: "Customer Portal (Sample)",
    description: "Sample enterprise Vue + Spring Boot project with user management and order processing",
  });

  const files = [
    { path: "src/views/UserManagement.vue", type: "vue", content: SAMPLE_VUE_COMPONENT },
    { path: "src/views/OrderDashboard.vue", type: "vue", content: SAMPLE_ORDER_VUE },
    { path: "src/router/index.js", type: "javascript", content: SAMPLE_VUE_ROUTER },
    { path: "src/main/java/com/app/controller/UserController.java", type: "java", content: SAMPLE_USER_CONTROLLER },
    { path: "src/main/java/com/app/controller/OrderController.java", type: "java", content: SAMPLE_ORDER_CONTROLLER },
    { path: "src/main/java/com/app/service/UserService.java", type: "java", content: SAMPLE_USER_SERVICE },
    { path: "src/main/java/com/app/service/OrderService.java", type: "java", content: SAMPLE_ORDER_SERVICE },
    { path: "src/main/java/com/app/service/NotificationService.java", type: "java", content: SAMPLE_NOTIFICATION_SERVICE },
    { path: "src/main/java/com/app/model/User.java", type: "java", content: SAMPLE_USER_ENTITY },
    { path: "src/main/java/com/app/model/Order.java", type: "java", content: SAMPLE_ORDER_ENTITY },
    { path: "src/main/java/com/app/model/Notification.java", type: "java", content: SAMPLE_NOTIFICATION_ENTITY },
    { path: "src/main/java/com/app/model/AuditLog.java", type: "java", content: SAMPLE_AUDIT_LOG_ENTITY },
    { path: "src/main/java/com/app/repository/UserRepository.java", type: "java", content: SAMPLE_USER_REPOSITORY },
    { path: "src/main/java/com/app/repository/OrderRepository.java", type: "java", content: SAMPLE_ORDER_REPOSITORY },
    { path: "src/main/java/com/app/repository/PaymentRepository.java", type: "java", content: SAMPLE_PAYMENT_REPOSITORY },
    { path: "src/main/java/com/app/repository/NotificationRepository.java", type: "java", content: SAMPLE_NOTIFICATION_REPOSITORY },
    { path: "src/main/java/com/app/repository/AuditLogRepository.java", type: "java", content: SAMPLE_AUDIT_LOG_REPOSITORY },
  ];

  for (const file of files) {
    await storage.createSourceFile({
      projectId: project.id,
      filePath: file.path,
      fileType: file.type,
      content: file.content,
    });
  }

  await storage.updateProjectStatus(project.id, "uploaded", files.length);
  console.log("Seed data created successfully.");
}
