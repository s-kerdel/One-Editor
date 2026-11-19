<?php
namespace App\Http\Controllers;
use App\Models\User;
class UserController extends Controller {
public function index(){ $users=User::query()->where('active',true)->orderBy('name')->get();
return view('users.index',['users'=>$users]); }
  public function show(int $id) { return User::findOrFail($id); }
}
